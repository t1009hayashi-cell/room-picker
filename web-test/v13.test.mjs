/**
 * 追加要件v1.3 のテスト（アプリ側）。
 * 価格帯プールの配分と、手動追加の入口を固定する。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPools, interleaveByRatio, priceTierOf } from '../docs/js/lib/pools.js';
import { buildManualItem, parseItemUrl } from '../docs/js/lib/manualItem.js';
import { roomPostUrl, roomSearchUrl, roomUrlFor } from '../docs/js/lib/room.js';
import { byPriceTier, excludeManualPosts } from '../docs/js/lib/aggregate.js';
import { matchResults } from '../docs/js/lib/match.js';

const reach = (i) => ({ itemCode: `r${i}`, priceTier: 'reach' });
const revenue = (i) => ({ itemCode: `v${i}`, priceTier: 'revenue' });
const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));

describe('価格帯の判定（追加要件v1.3 2章）', () => {
  it('日次JSONの priceTier をそのまま使う', () => {
    assert.equal(priceTierOf({ priceTier: 'reach', itemPrice: 99999 }), 'reach');
  });

  it('priceTier が無い古いデータは価格から求める（欠損時は落ちない）', () => {
    assert.equal(priceTierOf({ itemPrice: 1580 }), 'reach');
    assert.equal(priceTierOf({ itemPrice: 5398 }), 'revenue');
  });

  it('価格帯商品は最大価格で見る', () => {
    assert.equal(priceTierOf({ itemPrice: 2788, itemPriceMax: 8888, hasPriceRange: true }), 'revenue');
  });
});

describe('プールの交互取り出し（2.2 手順4）', () => {
  it('7:3 でリーチ枠を混ぜる', () => {
    const out = interleaveByRatio(many(20, reach), many(20, revenue), 0.7);
    const first10 = out.slice(0, 10);
    assert.equal(first10.filter((x) => x.priceTier === 'reach').length, 7);
  });

  it('どこで打ち切っても比率が保たれる', () => {
    const out = interleaveByRatio(many(50, reach), many(50, revenue), 0.7);
    for (const n of [10, 20, 30]) {
      const ratio = out.slice(0, n).filter((x) => x.priceTier === 'reach').length / n;
      assert.ok(Math.abs(ratio - 0.7) <= 0.05, `${n}件時点で ${ratio}`);
    }
  });

  it('比率を変えると配分も変わる（設定値で切り替えられること・2.4）', () => {
    const out = interleaveByRatio(many(20, reach), many(20, revenue), 0.3);
    assert.equal(out.slice(0, 10).filter((x) => x.priceTier === 'reach').length, 3);
  });

  it('一方が尽きたら他方から補充する（手順5）', () => {
    const out = interleaveByRatio(many(2, reach), many(5, revenue), 0.7);
    assert.equal(out.length, 7);
    assert.equal(out.filter((x) => x.priceTier === 'reach').length, 2);
  });

  it('リーチ枠が無くても落ちない', () => {
    assert.equal(interleaveByRatio([], many(3, revenue), 0.7).length, 3);
    assert.equal(interleaveByRatio(many(3, reach), [], 0.7).length, 3);
  });
});

describe('リーチ枠の不足を検知する（2.2 手順5）', () => {
  it('比率ぶん用意できなければ reachShort が立つ', () => {
    const r = buildPools([...many(7, reach), ...many(10, revenue)], { reachRatio: 0.7 });
    assert.equal(r.reachShort, true);
    assert.equal(r.reachCount, 7);
    assert.equal(r.revenueCount, 10);
  });

  it('足りていれば立たない', () => {
    const r = buildPools([...many(30, reach), ...many(10, revenue)], { reachRatio: 0.7 });
    assert.equal(r.reachShort, false);
  });

  it('件数は変えない（並べ替えるだけで候補を捨てない）', () => {
    const r = buildPools([...many(7, reach), ...many(10, revenue)], { reachRatio: 0.7 });
    assert.equal(r.items.length, 17);
  });
});

describe('手動追加（追加要件v1.3 5章）', () => {
  const settings = { minPrice: 1000, minReview: 200, minReviewAverage: 4.3 };

  it('商品URLから itemCode を取り出す', () => {
    const r = parseItemUrl('https://item.rakuten.co.jp/kyushumaistar/018/');
    assert.equal(r.ok, true);
    assert.equal(r.itemCode, 'kyushumaistar:018');
  });

  it('計測パラメータを落とす', () => {
    const r = parseItemUrl('https://item.rakuten.co.jp/shop/abc-123/?scid=af_pc_etc');
    assert.equal(r.itemUrl, 'https://item.rakuten.co.jp/shop/abc-123/');
  });

  it('楽天以外のURLは断る', () => {
    assert.equal(parseItemUrl('https://www.amazon.co.jp/dp/B01').ok, false);
    assert.equal(parseItemUrl('あいうえお').ok, false);
    assert.equal(parseItemUrl('').ok, false);
  });

  it('除外条件に該当しても除外しない。理由だけ警告として持つ（5.3）', () => {
    const item = buildManualItem(
      { ...parseItemUrl('https://item.rakuten.co.jp/s/1/'), itemName: 'x', itemPrice: 1980, shopName: 'y', reviewCount: 163 },
      settings,
    );
    assert.equal(item.excluded, false);
    assert.ok(item.manualWarnings.some((w) => w.includes('163')));
  });

  it('手入力分と分かる印を必ず立てる（5.4）', () => {
    const item = buildManualItem(
      { ...parseItemUrl('https://item.rakuten.co.jp/s/1/'), itemName: 'x', itemPrice: 1980, shopName: 'y' },
      settings,
    );
    assert.equal(item.source, 'manual');
    assert.equal(item.dataSource, 'manual-input');
    assert.equal(item.priceTier, 'reach');
  });
});

describe('集計での手動追加の扱い（5.5）', () => {
  const post = (patch) => ({ postId: 'p', itemNameRaw: 'n', criteria: [], hashtags: [], ...patch });

  it('手動追加を外せる', () => {
    const posts = [post({ postId: 'a', itemSource: 'manual' }), post({ postId: 'b', itemSource: 'ranking' })];
    assert.deepEqual(excludeManualPosts(posts).map((p) => p.postId), ['b']);
  });

  it('itemSource を持たない古いログはランキング扱いにする', () => {
    assert.equal(excludeManualPosts([post({ postId: 'a' })]).length, 1);
  });

  it('価格帯別に集計できる', () => {
    const posts = [
      post({ postId: 'a', priceTier: 'reach' }),
      post({ postId: 'b', priceTier: 'revenue', itemNameRaw: 'x' }),
      post({ postId: 'c', itemNameRaw: 'y' }),
    ];
    const { byPostId } = matchResults(posts, []);
    const keys = byPriceTier(posts, byPostId).map((r) => r.key).sort();
    assert.deepEqual(keys, ['（記録なし）', 'リーチ枠（1,000〜3,000円）', '収益枠（3,000円超）'].sort());
  });
});

describe('ROOMへの導線', () => {
  it('その商品の投稿画面を直接開く', () => {
    // 楽天市場の「ROOMに投稿」ボタンと同じ形式。itemCode をそのまま渡せる
    assert.equal(
      roomPostUrl('importshopaqua:10002978'),
      'https://room.rakuten.co.jp/mix?itemcode=importshopaqua%3A10002978',
    );
  });

  it('楽天側の計測パラメータ（scid）は付けない', () => {
    assert.ok(!roomPostUrl('shop:1').includes('scid'));
  });

  it('itemCode が取れないときは検索に落とす', () => {
    assert.equal(roomPostUrl(''), null);
    const url = roomUrlFor({ itemCode: '', itemName: '【送料無料】骨取りサバ切身 1kg 冷凍' });
    assert.ok(url.startsWith('https://room.rakuten.co.jp/search/item?keyword='));
    // 販促文を落とした短い形で渡す（長いとROOMの検索で弾かれる）
    assert.ok(decodeURIComponent(url).includes('骨取りサバ'));
    assert.ok(!decodeURIComponent(url).includes('送料無料'));
  });

  it('itemCode があれば投稿画面を優先する', () => {
    assert.ok(roomUrlFor({ itemCode: 'shop:1', itemName: 'x' }).includes('/mix?itemcode='));
  });
});
