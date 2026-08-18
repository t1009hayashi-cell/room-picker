import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchResults } from '../docs/js/lib/match.js';
import {
  MIN_SAMPLE,
  buildRateSuggestions,
  buildThresholdSuggestions,
  byHeaderType,
  byPurchased,
  labeledPosts,
  byFirstLineBand,
  bySalePeriod,
  byWeekday,
  byHourBand,
  rateComparison,
  statusOf,
  trafficSummary,
} from '../docs/js/lib/aggregate.js';
import { isExcludedForUser, applyChips, sameShopPostedOnDate } from '../docs/js/lib/filters.js';
import { splitComment, measureComment } from '../docs/js/lib/commentText.js';
import { calendarGrid, firstLineBand, addDays, nowJstIso, weekdayOf } from '../docs/js/lib/format.js';

const NAME = '送料無料 コーヒー豆 コーヒー 2kg 怒涛の珈琲豆 粉 (G500×4) 加藤珈琲/';

function post(patch = {}) {
  return {
    postId: patch.postId ?? 'p1',
    postedAt: '2026-08-05T07:12:00+09:00',
    itemCode: 'shop:1',
    itemNameRaw: NAME,
    shopName: 'グルメコーヒー豆専門！加藤珈琲店',
    genreId: '100227',
    genreName: '食品',
    itemPrice: 5398,
    estimatedReward: 324,
    reviewCount: 43088,
    headerType: '共感課題型',
    labelVersion: 'v2',
    firstLine: 'コーヒー、切らしてから慌てて買っていませんか？',
    firstLineLength: 24,
    commentBody: '本文',
    hashtags: ['#まとめ買い'],
    usedAiGeneration: false,
    duringSale: true,
    saleId: 'auto-1',
    rankAtPost: 10,
    rankChangeAtPost: 4,
    ...patch,
  };
}

function result(patch = {}) {
  return {
    occurredAt: '2026-08-05T21:33:00+09:00',
    itemNameRaw: NAME,
    shopName: 'グルメコーヒー豆専門！加藤珈琲店',
    genreName: '食品',
    salesAmount: 5398,
    reward: 324,
    rate: 0.04,
    deviceType: 'スマートフォン',
    trackingId: '楽天ROOM',
    status: '未確定',
    matchedPostId: null,
    ...patch,
  };
}

describe('突合ロジック（仕様書 10.3）', () => {
  it('itemNameRaw の完全一致で突合する', () => {
    const { matched, unmatched } = matchResults([post()], [result()]);
    assert.equal(matched.length, 1);
    assert.equal(matched[0].method, 'exact');
    assert.equal(unmatched.length, 0);
  });

  it('完全一致しない場合はショップ名一致＋前方30文字でフォールバックする', () => {
    const { matched } = matchResults([post()], [result({ itemNameRaw: `${NAME.slice(0, 40)} 別表記` })]);
    assert.equal(matched.length, 1);
    assert.equal(matched[0].method, 'prefix');
  });

  it('ショップ名が違えば前方一致でも突合しない', () => {
    const { matched, unmatched } = matchResults([post()], [result({ itemNameRaw: `${NAME.slice(0, 40)} 別表記`, shopName: '別のお店' })]);
    assert.equal(matched.length, 0);
    assert.equal(unmatched.length, 1);
  });

  it('未突合は捨てずに残す', () => {
    const { unmatched } = matchResults([], [result()]);
    assert.equal(unmatched.length, 1);
    assert.equal(unmatched[0].itemNameRaw, NAME);
  });

  it('同一商品を複数回投稿している場合は成果発生日時の直前の投稿に紐付ける', () => {
    const posts = [
      post({ postId: 'old', postedAt: '2026-07-01T08:00:00+09:00' }),
      post({ postId: 'recent', postedAt: '2026-08-05T07:12:00+09:00' }),
      post({ postId: 'future', postedAt: '2026-09-01T07:00:00+09:00' }),
    ];
    const { matched } = matchResults(posts, [result()]);
    assert.equal(matched[0].post.postId, 'recent');
  });

  it('手動で紐付けた成果はその投稿を尊重する', () => {
    const posts = [post({ postId: 'p1' }), post({ postId: 'p2', itemNameRaw: '別商品' })];
    const { matched } = matchResults(posts, [result({ matchedPostId: 'p2' })]);
    assert.equal(matched[0].post.postId, 'p2');
    assert.equal(matched[0].method, 'manual');
  });
});

describe('集計指標（仕様書 10.4 / 10.5）', () => {
  it('投稿数が10件未満の区分は数値を出さない', () => {
    const posts = Array.from({ length: 9 }, (_, i) => post({ postId: `p${i}`, itemNameRaw: `商品${i}` }));
    const { byPostId } = matchResults(posts, []);
    const rows = byHeaderType(posts, byPostId);
    assert.equal(rows[0].posts, 9);
    assert.equal(rows[0].enoughSample, false);
    assert.equal(rows[0].conversionRate, null);
    assert.equal(rows[0].rewardPerPost, null);
  });

  it('10件以上なら成約率と1投稿あたり報酬を出す', () => {
    const posts = Array.from({ length: MIN_SAMPLE }, (_, i) => post({ postId: `p${i}`, itemNameRaw: `商品${i}` }));
    const results = [result({ itemNameRaw: '商品0' }), result({ itemNameRaw: '商品1' })];
    const { byPostId } = matchResults(posts, results);
    const rows = byHeaderType(posts, byPostId);
    assert.equal(rows[0].enoughSample, true);
    assert.equal(rows[0].convertedPosts, 2);
    assert.equal(rows[0].conversionRate, 0.2);
    assert.equal(Math.round(rows[0].rewardPerPost), Math.round((324 * 2) / MIN_SAMPLE));
  });

  it('ヘッダーの文字数帯で分ける（推奨20〜30文字の前後で区切る）', () => {
    assert.equal(firstLineBand(12), '〜19');
    assert.equal(firstLineBand(25), '20〜30');
    assert.equal(firstLineBand(32), '31〜');
    const posts = [post({ postId: 'a', firstLineLength: 25 }), post({ postId: 'b', firstLineLength: 12, itemNameRaw: 'x' })];
    const { byPostId } = matchResults(posts, []);
    assert.deepEqual(byFirstLineBand(posts, byPostId).map((r) => r.key).sort(), ['20〜30', '〜19']);
  });

  it('確定・未確定・破棄を区別する', () => {
    assert.equal(statusOf(result({ status: '確定' })), 'confirmed');
    assert.equal(statusOf(result({ status: '未確定' })), 'pending');
    assert.equal(statusOf(result({ status: '破棄' })), 'discarded');
    assert.equal(statusOf(result({ status: '' })), 'unknown');

    const posts = [post()];
    const { byPostId } = matchResults(posts, [result({ status: '確定' }), result({ status: '破棄', occurredAt: '2026-08-06T10:00:00+09:00' })]);
    const row = byHeaderType(posts, byPostId)[0];
    assert.equal(row.rewardConfirmed, 324);
    assert.equal(row.discarded, 1);
    // 破棄分は報酬に含めない
    assert.equal(row.reward, 324);
  });

  it('セール期間内外で比較できる', () => {
    const posts = [post({ postId: 'a', duringSale: true }), post({ postId: 'b', duringSale: false, itemNameRaw: 'x' })];
    const { byPostId } = matchResults(posts, []);
    assert.deepEqual(bySalePeriod(posts, byPostId, []).map((r) => r.key).sort(), ['セール期間内', 'セール期間外']);
  });

  it('実料率と想定との乖離を出す', () => {
    const posts = [post()];
    const { byPostId } = matchResults(posts, [result({ reward: 500 })]);
    const row = rateComparison(posts, byPostId)[0];
    assert.equal(row.actualReward, 500);
    assert.equal(row.estimatedReward, 324);
    assert.equal(row.deviation, 176);
    assert.equal(Math.round(row.actualRate * 10000) / 10000, Math.round((500 / 5398) * 10000) / 10000);
  });

  it('ROOM経由の報酬比率とデバイス比率を出す', () => {
    const t = trafficSummary([result(), result({ trackingId: '', reward: 100, occurredAt: '2026-08-06T10:00:00+09:00' })]);
    assert.equal(t.roomReward, 324);
    assert.equal(t.allReward, 424);
    assert.equal(t.devices[0].key, 'スマートフォン');
  });

  it('サンプルが足りないうちは料率・閾値の提案をしない', () => {
    const posts = [post()];
    const { byPostId } = matchResults(posts, [result()]);
    assert.deepEqual(buildRateSuggestions(rateComparison(posts, byPostId), { 100227: 0.04 }), []);
    assert.equal(buildThresholdSuggestions(posts, byPostId, { minPrice: 3000, minReview: 500 }).enough, false);
  });

  it('サンプルが十分で乖離があれば料率の反映を提案する', () => {
    const posts = Array.from({ length: MIN_SAMPLE }, (_, i) => post({ postId: `p${i}`, itemNameRaw: `商品${i}` }));
    const results = posts.map((p, i) => result({ itemNameRaw: `商品${i}`, reward: 540, salesAmount: 5398 }));
    const { byPostId } = matchResults(posts, results);
    const suggestions = buildRateSuggestions(rateComparison(posts, byPostId), { 100227: 0.04 });
    assert.equal(suggestions.length, 1);
    assert.equal(Math.round(suggestions[0].actualRate * 100), 10);
  });
});

describe('絞り込みと再評価（仕様書 6.1 / 8.2）', () => {
  const item = {
    itemPriceMax: 2500,
    itemPrice: 2500,
    hasPriceRange: false,
    reviewCount: 300,
    postageFlag: 0,
    availability: 1,
    isRateBoosted: false,
    rankChange: 0,
    isNew: false,
    excludeReasons: ['price_below_min', 'review_below_min'],
  };

  it('閾値を緩めると除外が解ける', () => {
    assert.equal(isExcludedForUser(item, { minPrice: 3000, minReview: 500, excludeShippingFeeSeparate: true }).excluded, true);
    assert.equal(isExcludedForUser(item, { minPrice: 1000, minReview: 100, excludeShippingFeeSeparate: true }).excluded, false);
  });

  it('価格の足切り基準がバッチ側（src/filter.ts）と一致する', () => {
    const settings = { minPrice: 3000, minReview: 0, excludeShippingFeeSeparate: false };
    // 価格帯商品は上限で判定 → 通す
    const ranged = { ...item, hasPriceRange: true, itemPrice: 2788, itemPriceMax: 8888, excludeReasons: [] };
    assert.equal(isExcludedForUser(ranged, settings).excluded, false);
    // 価格帯でない商品は表示価格で判定 → 落とす
    const mismatched = { ...item, hasPriceRange: false, itemPrice: 2900, itemPriceMax: 3200, excludeReasons: [] };
    assert.deepEqual(isExcludedForUser(mismatched, settings).reasons, ['price_below_min']);
  });

  it('必須の除外条件は閾値を緩めても解けない', () => {
    const soldOut = { ...item, excludeReasons: ['out_of_stock'] };
    const r = isExcludedForUser(soldOut, { minPrice: 0, minReview: 0, excludeShippingFeeSeparate: false });
    assert.equal(r.excluded, true);
    assert.deepEqual(r.reasons, ['out_of_stock']);
  });

  it('送料別の除外は設定で切り替わる（0が送料込み）', () => {
    const paid = { ...item, postageFlag: 1, excludeReasons: [] };
    assert.equal(isExcludedForUser(paid, { minPrice: 0, minReview: 0, excludeShippingFeeSeparate: true }).excluded, true);
    assert.equal(isExcludedForUser(paid, { minPrice: 0, minReview: 0, excludeShippingFeeSeparate: false }).excluded, false);
  });

  it('絞り込みチップは AND で効く', () => {
    const items = [
      { isRateBoosted: true, postageFlag: 0, availability: 1, rankChange: 3, isNew: false },
      { isRateBoosted: false, postageFlag: 0, availability: 1, rankChange: 3, isNew: false },
      { isRateBoosted: true, postageFlag: 1, availability: 1, rankChange: 3, isNew: false },
    ];
    assert.equal(applyChips(items, new Set(['rateBoosted'])).length, 2);
    assert.equal(applyChips(items, new Set(['rateBoosted', 'freeShipping'])).length, 1);
    assert.equal(applyChips(items, new Set()).length, 3);
  });

  it('同日同ショップの投稿済みを検出する', () => {
    const posts = [post({ postId: 'a', itemCode: 'other' })];
    assert.equal(sameShopPostedOnDate(posts, post().shopName, '2026-08-05', 'shop:1').length, 1);
    assert.equal(sameShopPostedOnDate(posts, post().shopName, '2026-08-06', 'shop:1').length, 0);
    // 自分自身は数えない
    assert.equal(sameShopPostedOnDate(posts, post().shopName, '2026-08-05', 'other').length, 0);
  });
});

describe('投稿文テキストの分解', () => {
  it('末尾のハッシュタグ行を本文から切り離す', () => {
    const { body, hashtags } = splitComment('1行目\n2行目\n#a #b #c');
    assert.equal(body, '1行目\n2行目');
    assert.deepEqual(hashtags, ['#a', '#b', '#c']);
  });

  it('ハッシュタグ行が無ければ全体を本文とする', () => {
    const { body, hashtags } = splitComment('1行目\n2行目');
    assert.equal(body, '1行目\n2行目');
    assert.deepEqual(hashtags, []);
  });

  it('ハッシュタグを1行目に置いた投稿も切り離せる（プロンプトが認めている形）', () => {
    const { body, hashtags } = splitComment('#おせち早割 #2027おせち #年末の準備\n\n＼8月に予約する人／\n✅4〜5人前');
    assert.deepEqual(hashtags, ['#おせち早割', '#2027おせち', '#年末の準備']);
    assert.equal(body, '＼8月に予約する人／\n✅4〜5人前');
  });

  it('1行目にタグを置いた投稿でもタグ数を正しく数える', () => {
    // 数えられないと編集欄に常に警告が出て、投稿ログのタグも空になる
    assert.equal(measureComment('#a #b #c\n本文です').hashtagCount, 3);
  });

  it('タグと本文が混ざった行はタグ行とみなさない', () => {
    const { body, hashtags } = splitComment('#タグ から始まる本文\n2行目');
    assert.deepEqual(hashtags, []);
    assert.equal(body, '#タグ から始まる本文\n2行目');
  });

  it('推奨の型への適合を測れる（投稿プロンプトの実測値）', () => {
    // ヘッダー25字 ＋ 24字×12行=288字 ＝ 本文313字、タグ10個
    const tags = Array.from({ length: 10 }, (_, i) => `#t${i}`).join(' ');
    const bodyLines = Array.from({ length: 12 }, () => 'あ'.repeat(24)).join('\n');
    const ok = measureComment(`${'ヘ'.repeat(25)}\n${bodyLines}\n${tags}`);

    assert.equal(ok.firstLineLength, 25);
    assert.equal(ok.totalLength, 25 + 24 * 12);
    assert.equal(ok.lineCount, 13);
    assert.equal(ok.longLines, 0);
    assert.equal(ok.endsWithPeriod, false);
    assert.equal(ok.withinRules, true);

    // 短すぎる（旧基準の120〜180字はもう不適合）
    assert.equal(measureComment(`${'あ'.repeat(25)}\n${'い'.repeat(120)}\n${tags}`).withinRules, false);

    // タグが3個だと不適合（10〜15個が推奨）
    assert.equal(measureComment(`${'ヘ'.repeat(25)}\n${bodyLines}\n#a #b #c`).withinRules, false);

    // 30字を超える行があると不適合（20〜24字で改行する）
    const longLine = measureComment(`${'ヘ'.repeat(25)}\n${'あ'.repeat(40)}\n${bodyLines}\n${tags}`);
    assert.equal(longLine.longLines, 1);
    assert.equal(longLine.withinRules, false);

    // 文末が「。」だと不適合
    const period = measureComment(`${'ヘ'.repeat(25)}\n${bodyLines}。\n${tags}`);
    assert.equal(period.endsWithPeriod, true);
    assert.equal(period.withinRules, false);
  });

  it('タグ込みの文字数を測れる（ROOMの上限500文字に収めるため）', () => {
    const tags = Array.from({ length: 10 }, (_, i) => `#tag${i}`).join(' ');
    const m = measureComment(`${'ヘ'.repeat(25)}\n${'あ'.repeat(100)}\n${tags}`);
    assert.equal(m.totalLength, 125);
    assert.equal(m.overallLength, 125 + tags.length);
    assert.ok(m.overallLength > m.totalLength);
  });
});

describe('JST固定の集計（端末のタイムゾーンに依存しない）', () => {
  it('曜日・時刻帯を JST で分ける', () => {
    // UTC では 2026-08-04 22:30Z（火曜）だが、JST では 2026-08-05 07:30（水曜・6-11時）
    const posts = [post({ postId: 'a', postedAt: '2026-08-05T07:30:00+09:00' })];
    const { byPostId } = matchResults(posts, []);
    assert.equal(byWeekday(posts, byPostId)[0].key, '水曜');
    assert.equal(byHourBand(posts, byPostId)[0].key, '6-11時');
  });

  it('同日同ショップの判定も JST の日付で行う', () => {
    // JST 2026-08-05 00:30 は UTC では 08-04。UTCで切ると別日と誤判定する
    const posts = [post({ postId: 'a', itemCode: 'other', postedAt: '2026-08-05T00:30:00+09:00' })];
    assert.equal(sameShopPostedOnDate(posts, post().shopName, '2026-08-05', 'shop:1').length, 1);
  });

  it('nowJstIso は +09:00 表記を返す', () => {
    assert.equal(nowJstIso(new Date('2026-08-04T22:30:00Z')), '2026-08-05T07:30:00+09:00');
  });
});

describe('カレンダーの日付計算', () => {
  it('6週42セルを日曜始まりで返す', () => {
    const cells = calendarGrid(2026, 8);
    assert.equal(cells.length, 42);
    assert.equal(cells[0].dow, 0);
    assert.equal(cells.filter((c) => c.inMonth).length, 31);
    assert.equal(cells.find((c) => c.dateKey === '2026-08-01').inMonth, true);
  });

  it('月またぎの加算と曜日が一致する', () => {
    assert.equal(addDays('2026-07-31', 1), '2026-08-01');
    assert.equal(weekdayOf('2026-08-01'), '土');
    assert.equal(weekdayOf('2026-08-05'), '水');
  });
});
