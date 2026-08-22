import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateExclusion } from '../src/filter.js';
import { mergeByItemCode, normalizeItem, sortByRank, truncate } from '../src/normalize.js';
import { calcEstimatedReward } from '../src/reward.js';
import { calcHotScore } from '../src/score.js';
import { detectSales, mergeSales } from '../src/sales.js';
import { buildPrevRankIndex, calcRankDiff } from '../src/diff.js';
import type { GenreConfig, RakutenRawItem, SaleEntry } from '../src/types.js';
import { config, FIXED_NOW } from './helpers.js';
import { jstDayStart } from '../src/util/datetime.js';

const GENRE: GenreConfig = { genreId: '100356', genreName: 'コーヒー', commissionRate: 0.04, enabled: true };

async function normalize(raw: RakutenRawItem, source: 'ranking' | 'search' = 'ranking') {
  const { scoring } = await config();
  const item = normalizeItem(raw, { source, genre: GENRE, scoring, applicationId: 'app-id' });
  assert.ok(item, 'normalizeItem が null を返した');
  return item;
}

describe('normalize（仕様書 5.1）', () => {
  it('文字列の価格・料率・レビュー平均を数値化する', async () => {
    const item = await normalize({
      itemCode: 'shop:1',
      itemPrice: '5398',
      reviewAverage: '4.53',
      reviewCount: 43088,
      affiliateRate: '4.0',
    });
    assert.equal(item.itemPrice, 5398);
    assert.equal(item.reviewAverage, 4.53);
    assert.equal(item.reviewCount, 43088);
    assert.equal(item.affiliateRate, 0.04);
    assert.equal(item.affiliateRateSource, 'api');
  });

  it('affiliateRate が欠損した場合のみジャンル設定をフォールバックに使う（仕様書 4.4）', async () => {
    const withRate = await normalize({ itemCode: 'a', affiliateRate: '6.0' });
    assert.equal(withRate.affiliateRate, 0.06);
    assert.equal(withRate.affiliateRateSource, 'api');

    const without = await normalize({ itemCode: 'b', affiliateRate: '' });
    assert.equal(without.affiliateRate, 0.04);
    assert.equal(without.affiliateRateSource, 'genre-fallback');
  });

  it('5%以上を料率アップ商品として判定する（仕様書 6.2）', async () => {
    assert.equal((await normalize({ itemCode: 'a', affiliateRate: '4.9' })).isRateBoosted, false);
    assert.equal((await normalize({ itemCode: 'b', affiliateRate: '5.0' })).isRateBoosted, true);
    assert.equal((await normalize({ itemCode: 'c', affiliateRate: '10.0' })).isRateBoosted, true);
  });

  it('itemCaption を300文字で切り詰める', async () => {
    const item = await normalize({ itemCode: 'a', itemCaption: 'あ'.repeat(5000) });
    assert.equal(Array.from(item.itemCaptionShort).length, 300);
  });

  it('rafcid を除去する', async () => {
    const item = await normalize({
      itemCode: 'a',
      itemUrl: 'https://item.rakuten.co.jp/s/i/?rafcid=wsc_i_ra_app-id',
      shopUrl: 'https://www.rakuten.co.jp/s/?rafcid=wsc_i_ra_app-id',
    });
    assert.equal(item.itemUrl.includes('rafcid'), false);
    assert.equal(item.itemUrl.includes('app-id'), false);
    assert.equal(item.shopUrl.includes('rafcid'), false);
  });

  it('空文字の日時を null にする', async () => {
    const item = await normalize({ itemCode: 'a', startTime: '', endTime: '', pointRateStartTime: '' });
    assert.equal(item.priceStartTime, null);
    assert.equal(item.priceEndTime, null);
    assert.equal(item.pointRateStart, null);
  });

  it('価格帯商品の min / max を取り出す', async () => {
    const item = await normalize({
      itemCode: 'a',
      itemPrice: '2788',
      hasPriceRange: 1,
      itemPriceMin1: '2788',
      itemPriceMax1: '8888',
    });
    assert.equal(item.hasPriceRange, true);
    assert.equal(item.itemPriceMin, 2788);
    assert.equal(item.itemPriceMax, 8888);
    assert.equal(item.priceMismatch, false);
  });

  it('itemPrice が itemPriceMin/Max と食い違う商品にフラグを立てる（仕様書 6.1）', async () => {
    const item = await normalize({
      itemCode: 'a',
      itemPrice: '5506',
      hasPriceRange: 0,
      itemPriceMin1: '6478',
      itemPriceMax1: '6478',
    });
    assert.equal(item.priceMismatch, true);
    assert.equal(item.itemPrice, 5506);
  });

  it('itemCode が無い行は保存しない', async () => {
    const { scoring } = await config();
    assert.equal(normalizeItem({ itemName: 'x' }, { source: 'ranking', genre: GENRE, scoring }), null);
  });

  it('truncate はサロゲートペアを壊さない', () => {
    assert.equal(truncate('𩸽𩸽𩸽', 2), '𩸽𩸽');
  });
});

describe('sortByRank（仕様書 4.1 配列順を順位とみなさない）', () => {
  it('rank 昇順に並べ替える', () => {
    const sorted = sortByRank([{ rank: 30 }, { rank: 1 }, { rank: 15 }]);
    assert.deepEqual(sorted.map((i) => i.rank), [1, 15, 30]);
  });

  it('rank を持たない検索API由来は末尾に回す', () => {
    const sorted = sortByRank([{ rank: null }, { rank: 3 }, { rank: null }, { rank: 1 }]);
    assert.deepEqual(sorted.map((i) => i.rank), [1, 3, null, null]);
  });
});

describe('mergeByItemCode（仕様書 4.2）', () => {
  it('itemCode の重複を除き、ランキング由来を優先する', async () => {
    const ranking = [await normalize({ itemCode: 'dup', rank: 5 }, 'ranking')];
    const search = [
      await normalize({ itemCode: 'dup' }, 'search'),
      await normalize({ itemCode: 'only-search' }, 'search'),
    ];
    const merged = mergeByItemCode(ranking, search);
    assert.equal(merged.length, 2);
    assert.equal(merged.find((i) => i.itemCode === 'dup')?.source, 'ranking');
  });
});

describe('reward（仕様書 6.2）', () => {
  it('仕様書の例（5398円・4%）と一致する', async () => {
    const { scoring } = await config();
    const r = calcEstimatedReward(
      { itemPrice: 5398, itemPriceMin: 5398, hasPriceRange: false, affiliateRate: 0.04, isRateBoosted: false },
      scoring,
    );
    assert.equal(r.estimatedReward, 324);
    assert.equal(r.rewardCapApplied, false);
  });

  it('通常商品は1,000円の上限が効く', async () => {
    const { scoring } = await config();
    const r = calcEstimatedReward(
      { itemPrice: 200000, itemPriceMin: 200000, hasPriceRange: false, affiliateRate: 0.04, isRateBoosted: false },
      scoring,
    );
    // 200000*0.04=8000 → 1000、200000*0.02=4000 → 1000
    assert.equal(r.estimatedReward, 2000);
    assert.equal(r.rewardCapApplied, true);
  });

  it('料率アップ商品には上限を適用しない', async () => {
    const { scoring } = await config();
    const r = calcEstimatedReward(
      { itemPrice: 200000, itemPriceMin: 200000, hasPriceRange: false, affiliateRate: 0.06, isRateBoosted: true },
      scoring,
    );
    assert.equal(r.estimatedReward, 200000 * 0.06 + 200000 * 0.02);
    assert.equal(r.rewardCapApplied, false);
  });

  it('価格帯商品は itemPriceMin で保守的に見積もる', async () => {
    const { scoring } = await config();
    const r = calcEstimatedReward(
      { itemPrice: 2788, itemPriceMin: 2788, hasPriceRange: true, affiliateRate: 0.04, isRateBoosted: false },
      scoring,
    );
    assert.equal(r.basePrice, 2788);
  });
});

describe('hotScore（仕様書 6.3）', () => {
  const base = {
    source: 'ranking' as const,
    rank: 10,
    prevRank: 14,
    isNew: false,
    hasPrevSnapshot: true,
    reviewCount: 43088,
    itemPrice: 5398,
    isRateBoosted: false,
    pointRate: 10,
  };

  it('順位上昇・レビュー・価格帯・ポイント倍率を加算する', async () => {
    const { scoring } = await config();
    // (14-10)*5=20 + min(43.088,20)=20 + 収益枠10 + ポイント10 = 60
    assert.equal(calcHotScore(base, scoring), 60);
  });

  it('リーチ枠（1,000〜3,000円）のほうが価格加点が大きい（追加要件v1.3 2.3）', async () => {
    const { scoring } = await config();
    // 旧実装は「5,000〜25,000円で+15」で、リーチ枠は加点対象外だった
    const reach = calcHotScore({ ...base, itemPrice: 1580 }, scoring);
    const revenue = calcHotScore({ ...base, itemPrice: 5398 }, scoring);
    assert.equal(reach - revenue, 5);
    // 25,000円を超えると価格加点は付かない
    const tooHigh = calcHotScore({ ...base, itemPrice: 30000 }, scoring);
    assert.equal(revenue - tooHigh, 10);
  });

  it('新規ランクインは +30', async () => {
    const { scoring } = await config();
    const withPrev = calcHotScore({ ...base, prevRank: null, isNew: true }, scoring);
    assert.equal(withPrev, 30 + 20 + 10 + 10);
  });

  it('前日スナップショットが無い初回実行では上昇幅ボーナスを付けない（仕様書 6.4）', async () => {
    const { scoring } = await config();
    const first = calcHotScore({ ...base, prevRank: null, isNew: true, hasPrevSnapshot: false }, scoring);
    assert.equal(first, 20 + 10 + 10);
  });

  it('検索API由来は上昇幅の項を0にする', async () => {
    const { scoring } = await config();
    const s = calcHotScore({ ...base, source: 'search', rank: null, prevRank: null }, scoring);
    assert.equal(s, 20 + 10 + 10);
  });

  it('料率アップ商品は +40', async () => {
    const { scoring } = await config();
    assert.equal(calcHotScore({ ...base, isRateBoosted: true }, scoring) - calcHotScore(base, scoring), 40);
  });

  it('順位が下がるとマイナスになる', async () => {
    const { scoring } = await config();
    assert.equal(calcHotScore({ ...base, rank: 20, prevRank: 10 }, scoring), -50 + 20 + 10 + 10);
  });
});

describe('filter（仕様書 6.1）', () => {
  const earliest = jstDayStart('2026-08-02');
  const ok = {
    itemName: 'コーヒー豆 2kg',
    itemPrice: 5398,
    itemPriceMax: 5398,
    hasPriceRange: false,
    reviewCount: 43088,
    reviewAverage: 4.6,
    availability: 1,
    postageFlag: 0,
    priceEndTime: null,
    rankChange: null,
  };

  it('条件を満たす商品は除外されない', async () => {
    const { scoring, ngWords } = await config();
    const r = evaluateExclusion(ok, scoring, ngWords, earliest);
    assert.equal(r.excluded, false);
    assert.equal(r.excludeReason, null);
  });

  it('価格帯商品の足切りは itemPriceMax を使う（ランキング上位を取り逃さない）', async () => {
    const { scoring, ngWords } = await config();
    // 澤井珈琲ケース: itemPrice 2788 だが価格帯の上限は 8888
    const r = evaluateExclusion(
      { ...ok, hasPriceRange: true, itemPrice: 2788, itemPriceMax: 8888 },
      scoring,
      ngWords,
      earliest,
    );
    assert.equal(r.excludeReasons.includes('price_below_min'), false);

    // 追加要件v1.3 0章で下限は1,000円。ちょうど1,000円は通す
    const atMin = evaluateExclusion({ ...ok, itemPrice: 1000, itemPriceMax: 1000 }, scoring, ngWords, earliest);
    assert.equal(atMin.excludeReasons.includes('price_below_min'), false);

    const low = evaluateExclusion({ ...ok, itemPrice: 980, itemPriceMax: 980 }, scoring, ngWords, earliest);
    assert.equal(low.excludeReasons.includes('price_below_min'), true);
  });

  it('価格帯でない商品は表示価格（itemPrice）で足切りする', async () => {
    const { scoring, ngWords } = await config();
    // itemPrice 900 / itemPriceMax 3200 の食い違い商品。表示価格が閾値未満なので除外する
    const r = evaluateExclusion(
      { ...ok, hasPriceRange: false, itemPrice: 900, itemPriceMax: 3200 },
      scoring,
      ngWords,
      earliest,
    );
    assert.equal(r.excludeReasons.includes('price_below_min'), true);
  });

  it('リーチ枠（1,000〜3,000円）が価格で落ちない（追加要件v1.3 0章）', async () => {
    const { scoring, ngWords } = await config();
    // 下限3,000円のままだと、プロンプトが主力と定めるリーチ枠が機械的に全滅していた
    for (const price of [1180, 1580, 2980]) {
      const r = evaluateExclusion({ ...ok, itemPrice: price, itemPriceMax: price }, scoring, ngWords, earliest);
      assert.equal(r.excludeReasons.includes('price_below_min'), false, `${price}円が落ちている`);
    }
  });

  it('postageFlag は 1（送料別）を除外する。0（送料込み）は残す', async () => {
    const { scoring, ngWords } = await config();
    assert.equal(
      evaluateExclusion({ ...ok, postageFlag: 0 }, scoring, ngWords, earliest).excludeReasons.includes('shipping_fee_separate'),
      false,
    );
    assert.equal(
      evaluateExclusion({ ...ok, postageFlag: 1 }, scoring, ngWords, earliest).excludeReasons.includes('shipping_fee_separate'),
      true,
    );
  });

  it('availability 0（売り切れ）を除外する', async () => {
    const { scoring, ngWords } = await config();
    assert.equal(
      evaluateExclusion({ ...ok, availability: 0 }, scoring, ngWords, earliest).excludeReasons.includes('out_of_stock'),
      true,
    );
  });

  it('投稿予定日より前に価格が切れる商品を除外する', async () => {
    const { scoring, ngWords } = await config();
    const expired = evaluateExclusion({ ...ok, priceEndTime: '2026-08-01T14:59:00+09:00' }, scoring, ngWords, earliest);
    assert.equal(expired.excludeReasons.includes('price_expired'), true);

    const alive = evaluateExclusion({ ...ok, priceEndTime: '2026-08-20T23:59:00+09:00' }, scoring, ngWords, earliest);
    assert.equal(alive.excludeReasons.includes('price_expired'), false);
  });

  it('定期購入・健康訴求語を除外する', async () => {
    const { scoring, ngWords } = await config();
    assert.equal(
      evaluateExclusion({ ...ok, itemName: 'コーヒー 定期購入 2kg' }, scoring, ngWords, earliest).excludeReasons.includes('subscription_word'),
      true,
    );
    assert.equal(
      evaluateExclusion({ ...ok, itemName: '血圧が気になる方へ' }, scoring, ngWords, earliest).excludeReasons.includes('health_word'),
      true,
    );
  });

  it('複数理由をすべて残す（閾値を緩めたときに再利用するため）', async () => {
    const { scoring, ngWords } = await config();
    const r = evaluateExclusion(
      { ...ok, itemPrice: 100, itemPriceMax: 100, reviewCount: 0, availability: 0 },
      scoring,
      ngWords,
      earliest,
    );
    assert.deepEqual(r.excludeReasons, ['price_below_min', 'review_below_min', 'out_of_stock']);
  });
});

describe('sales 自動検出（仕様書 5.2）', () => {
  const marathonStart = '2026-08-04T20:00:00+09:00';
  const marathonEnd = '2026-08-11T01:59:00+09:00';

  it('異なる3ショップ以上が共有する期間を検出する', async () => {
    const { scoring } = await config();
    const sales = detectSales(
      [
        { shopCode: 'a', pointRateStart: marathonStart, pointRateEnd: marathonEnd },
        { shopCode: 'b', pointRateStart: marathonStart, pointRateEnd: marathonEnd },
        { shopCode: 'c', pointRateStart: marathonStart, pointRateEnd: marathonEnd },
      ],
      scoring,
      FIXED_NOW,
    );
    assert.equal(sales.length, 1);
    assert.equal(sales[0]?.start, marathonStart);
    assert.equal(sales[0]?.name, 'セール期間（自動検出）');
    assert.equal(sales[0]?.source, 'auto');
    assert.equal(sales[0]?.userLabel, null);
  });

  it('同一ショップ内の重複は3件と数えない', async () => {
    const { scoring } = await config();
    const sales = detectSales(
      [
        { shopCode: 'same', pointRateStart: marathonStart, pointRateEnd: marathonEnd },
        { shopCode: 'same', pointRateStart: marathonStart, pointRateEnd: marathonEnd },
        { shopCode: 'same', pointRateStart: marathonStart, pointRateEnd: marathonEnd },
        { shopCode: 'same', pointRateStart: marathonStart, pointRateEnd: marathonEnd },
        { shopCode: 'same', pointRateStart: marathonStart, pointRateEnd: marathonEnd },
      ],
      scoring,
      FIXED_NOW,
    );
    assert.equal(sales.length, 0);
  });

  it('9999-12-31 23:59 の恒常設定は除外する（澤井珈琲ケース）', async () => {
    const { scoring } = await config();
    const sales = detectSales(
      ['a', 'b', 'c', 'd', 'e'].map((shopCode) => ({
        shopCode,
        pointRateStart: '2025-10-28T14:00:00+09:00',
        pointRateEnd: '9999-12-31T23:59:00+09:00',
      })),
      scoring,
      FIXED_NOW,
    );
    assert.equal(sales.length, 0);
  });

  it('60日を超える期間と、終了済みの期間は除外する', async () => {
    const { scoring } = await config();
    const long = detectSales(
      ['a', 'b', 'c'].map((shopCode) => ({
        shopCode,
        pointRateStart: '2026-08-01T00:00:00+09:00',
        pointRateEnd: '2026-12-31T23:59:00+09:00',
      })),
      scoring,
      FIXED_NOW,
    );
    assert.equal(long.length, 0);

    const past = detectSales(
      ['a', 'b', 'c'].map((shopCode) => ({
        shopCode,
        pointRateStart: '2026-07-01T00:00:00+09:00',
        pointRateEnd: '2026-07-05T23:59:00+09:00',
      })),
      scoring,
      FIXED_NOW,
    );
    assert.equal(past.length, 0);
  });

  it('手動登録は自動検出より優先し、userLabel は引き継ぐ', () => {
    const manual: SaleEntry = {
      id: 'manual-1',
      name: 'お買い物マラソン',
      start: marathonStart,
      end: marathonEnd,
      itemCount: 0,
      source: 'manual',
      userLabel: 'お買い物マラソン',
    };
    const auto: SaleEntry = {
      id: 'auto-20260804-20260811',
      name: 'セール期間（自動検出）',
      start: marathonStart,
      end: marathonEnd,
      itemCount: 12,
      source: 'auto',
      userLabel: null,
    };
    assert.deepEqual(mergeSales([manual], [auto]), [manual]);

    const labeled = mergeSales([{ ...auto, userLabel: 'ブランドデー' }], [auto]);
    assert.equal(labeled[0]?.userLabel, 'ブランドデー');
  });
});

describe('前日比（仕様書 6.4）', () => {
  it('前日スナップショットが無ければ prevRank:null / isNew:true / ボーナスなし', () => {
    const index = buildPrevRankIndex(null);
    assert.equal(index.hasPrevSnapshot, false);
    const diff = calcRankDiff('a', 5, 'ranking', index);
    assert.deepEqual(diff, { prevRank: null, rankChange: null, isNew: true });
  });

  it('前日にあれば rankChange を計算する', () => {
    const index = buildPrevRankIndex({
      fetchedAt: '',
      date: '2026-07-31',
      generatedBy: 'mock',
      genres: [
        {
          genreId: '1',
          genreName: 'g',
          commissionRate: 0.04,
          warnings: [],
          items: [{ itemCode: 'a', rank: 14 } as never],
        },
      ],
    });
    assert.deepEqual(calcRankDiff('a', 10, 'ranking', index), { prevRank: 14, rankChange: 4, isNew: false });
    assert.deepEqual(calcRankDiff('b', 10, 'ranking', index), { prevRank: null, rankChange: null, isNew: true });
  });

  it('検索API由来は NEW 扱いにしない', () => {
    const index = buildPrevRankIndex(null);
    assert.deepEqual(calcRankDiff('a', null, 'search', index), { prevRank: null, rankChange: null, isNew: false });
  });
});
