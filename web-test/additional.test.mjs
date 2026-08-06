import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CHIP_FILTERS,
  NEWCOMER,
  applyChips,
  hasCoupon,
  hasDiscount,
  isExcludedForUser,
  isNewcomerItem,
} from '../docs/js/lib/filters.js';
import { KITCHEN_GENRE_ID, KITCHEN_RATIO_LIMIT, genreRatio } from '../docs/js/lib/aggregate.js';

const SETTINGS = {
  minPrice: 3000,
  minReview: 200,
  minReviewAverage: 4.3,
  excludeShippingFeeSeparate: true,
};

function item(patch = {}) {
  return {
    itemCode: 'shop:1',
    itemPrice: 5000,
    itemPriceMax: 5000,
    hasPriceRange: false,
    reviewCount: 1000,
    reviewAverage: 4.6,
    postageFlag: 0,
    availability: 1,
    rankChange: 0,
    excludeReasons: [],
    discount: { discountRate: null, hasCoupon: false, discountExpired: false },
    ...patch,
  };
}

describe('レビュー平均による除外（追加要件 1章）', () => {
  it('4.3未満は除外する', () => {
    // 実データ: レビュー1,571件・評価4.16の商品。件数は十分でも評価が低い
    const r = isExcludedForUser(item({ reviewCount: 1571, reviewAverage: 4.16 }), SETTINGS);
    assert.equal(r.excluded, true);
    assert.ok(r.reasons.includes('review_average_below_min'));
  });

  it('4.3以上は通す', () => {
    assert.equal(isExcludedForUser(item({ reviewAverage: 4.3 }), SETTINGS).excluded, false);
  });

  it('レビュー件数200以上を通す（旧基準の500では定番しか残らない）', () => {
    assert.equal(isExcludedForUser(item({ reviewCount: 200 }), SETTINGS).excluded, false);
    assert.ok(isExcludedForUser(item({ reviewCount: 199 }), SETTINGS).reasons.includes('review_below_min'));
  });

  it('レビューが無い商品（平均0）は平均で除外しない', () => {
    // 平均0は「評価が低い」ではなく「まだ評価が無い」。件数の条件で判断する
    const r = isExcludedForUser(item({ reviewCount: 300, reviewAverage: 0 }), SETTINGS);
    assert.equal(r.reasons.includes('review_average_below_min'), false);
  });

  it('平均の下限を0にすると判定しない（設定で無効化できる）', () => {
    const r = isExcludedForUser(item({ reviewAverage: 3.0 }), { ...SETTINGS, minReviewAverage: 0 });
    assert.equal(r.reasons.includes('review_average_below_min'), false);
  });

  it('閾値を緩めると復活する（除外理由が閾値由来として扱われている）', () => {
    const low = item({ reviewAverage: 4.16, excludeReasons: ['review_average_below_min'] });
    assert.equal(isExcludedForUser(low, SETTINGS).excluded, true);
    assert.equal(isExcludedForUser(low, { ...SETTINGS, minReviewAverage: 4.0 }).excluded, false);
  });
});

describe('新着ブースト（追加要件 1.2）', () => {
  it('レビュー50件以上かつ順位が3つ以上上昇なら該当', () => {
    assert.equal(isNewcomerItem(item({ reviewCount: 50, rankChange: 3 })), true);
    assert.equal(NEWCOMER.minReviewCount, 50);
    assert.equal(NEWCOMER.minRankChange, 3);
  });

  it('条件を満たすとレビュー平均の除外を免除する', () => {
    const newcomer = item({ reviewCount: 300, reviewAverage: 3.9, rankChange: 5 });
    const r = isExcludedForUser(newcomer, SETTINGS);
    assert.equal(r.reasons.includes('review_average_below_min'), false);
    assert.equal(r.excluded, false);
  });

  it('レビューが少なすぎる／順位が上がっていない商品は免除しない', () => {
    assert.equal(isNewcomerItem(item({ reviewCount: 49, rankChange: 10 })), false);
    assert.equal(isNewcomerItem(item({ reviewCount: 500, rankChange: 2 })), false);
    assert.equal(isNewcomerItem(item({ reviewCount: 500, rankChange: -5 })), false);
  });

  it('前日データが無い初回（rankChange が null）は免除しない', () => {
    assert.equal(isNewcomerItem(item({ reviewCount: 500, rankChange: null })), false);
  });
});

describe('割引・クーポンの絞り込み（追加要件 4章）', () => {
  it('チップが定義されている', () => {
    for (const id of ['discounted', 'coupon']) {
      assert.ok(CHIP_FILTERS.some((c) => c.id === id), `${id} が無い`);
    }
  });

  it('割引ありを判定する', () => {
    assert.equal(hasDiscount(item({ discount: { discountRate: 30, hasCoupon: false } })), true);
    assert.equal(hasDiscount(item()), false);
  });

  it('期限切れの割引は「割引あり」にしない', () => {
    // extractDiscount が discountRate を null に戻しているため
    const expired = item({ discount: { discountRate: null, hasCoupon: true, discountExpired: true } });
    assert.equal(hasDiscount(expired), false);
    // クーポンの有無自体は事実として残る
    assert.equal(hasCoupon(expired), true);
  });

  it('絞り込みとして効く', () => {
    const items = [
      item({ discount: { discountRate: 40, hasCoupon: false } }),
      item({ discount: { discountRate: null, hasCoupon: true } }),
      item(),
    ];
    assert.equal(applyChips(items, new Set(['discounted'])).length, 1);
    assert.equal(applyChips(items, new Set(['coupon'])).length, 1);
    assert.equal(applyChips(items, new Set(['discounted', 'coupon'])).length, 0);
  });

  it('discount を持たない古いデータでも落ちない', () => {
    const old = { itemCode: 'x' };
    assert.equal(hasDiscount(old), false);
    assert.equal(hasCoupon(old), false);
  });
});

describe('キッチン用品の比率（追加要件 5.1）', () => {
  const now = new Date('2026-08-04T12:00:00+09:00');
  const post = (genreId, daysAgo = 1) => ({
    postId: `p${Math.random()}`,
    genreId,
    postedAt: new Date(now.getTime() - daysAgo * 86400000).toISOString(),
  });

  it('直近30日の比率を出す', () => {
    const posts = [post(KITCHEN_GENRE_ID), post(KITCHEN_GENRE_ID), post('100227'), post('100227')];
    const r = genreRatio(posts, KITCHEN_GENRE_ID, 30, now);
    assert.equal(r.total, 4);
    assert.equal(r.count, 2);
    assert.equal(r.ratio, 0.5);
    assert.equal(r.overLimit, true);
  });

  it('30%を超えたら警告する', () => {
    assert.equal(KITCHEN_RATIO_LIMIT, 0.3);
    // 3/10 = 30% はちょうど上限なので超えていない
    const ten = [...Array(3)].map(() => post(KITCHEN_GENRE_ID)).concat([...Array(7)].map(() => post('100227')));
    assert.equal(genreRatio(ten, KITCHEN_GENRE_ID, 30, now).overLimit, false);
    // 4/10 = 40% は超えている
    const over = [...Array(4)].map(() => post(KITCHEN_GENRE_ID)).concat([...Array(6)].map(() => post('100227')));
    assert.equal(genreRatio(over, KITCHEN_GENRE_ID, 30, now).overLimit, true);
  });

  it('30日より前の投稿は数えない', () => {
    const posts = [post(KITCHEN_GENRE_ID, 40), post('100227', 1)];
    const r = genreRatio(posts, KITCHEN_GENRE_ID, 30, now);
    assert.equal(r.total, 1);
    assert.equal(r.count, 0);
  });

  it('投稿が0件なら比率を出さない（0%と出すと問題なしに見えてしまう）', () => {
    const r = genreRatio([], KITCHEN_GENRE_ID, 30, now);
    assert.equal(r.total, 0);
    assert.equal(r.ratio, null);
    assert.equal(r.overLimit, false);
  });
});
