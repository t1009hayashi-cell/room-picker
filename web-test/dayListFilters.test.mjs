import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyChips, CHIP_FILTERS, HIGH_POINT_RATE, isLimitedTimePrice } from '../docs/js/lib/filters.js';

function item(patch = {}) {
  return {
    itemCode: 'shop:1',
    hotScore: 10,
    pointRate: 1,
    priceStartTime: null,
    priceEndTime: null,
    postageFlag: 0,
    availability: 1,
    isRateBoosted: false,
    isNew: false,
    rankChange: 0,
    estimatedReward: 100,
    ...patch,
  };
}

const chipId = (id) => {
  const chip = CHIP_FILTERS.find((c) => c.id === id);
  assert.ok(chip, `${id} のチップが定義されていない`);
  return chip;
};

describe('ポイント高倍率の絞り込み', () => {
  it('商品カードのバッジと同じ基準（5倍以上）を使う', () => {
    assert.equal(HIGH_POINT_RATE, 5);
  });

  it('5倍以上だけを残す', () => {
    const items = [item({ pointRate: 1 }), item({ pointRate: 5 }), item({ pointRate: 20 })];
    const kept = applyChips(items, new Set(['highPoint']));
    assert.deepEqual(
      kept.map((i) => i.pointRate),
      [5, 20],
    );
  });

  it('pointRate が無い商品は除く（欠損を高倍率と誤認しない）', () => {
    assert.equal(chipId('highPoint').test(item({ pointRate: undefined })), false);
    assert.equal(chipId('highPoint').test(item({ pointRate: null })), false);
  });
});

describe('期間限定価格の絞り込み', () => {
  it('価格の終了日時があれば該当', () => {
    assert.equal(isLimitedTimePrice(item({ priceEndTime: '2026-08-05T23:59:00+09:00' })), true);
  });

  it('開始日時だけでも該当', () => {
    assert.equal(isLimitedTimePrice(item({ priceStartTime: '2026-08-04T20:00:00+09:00' })), true);
  });

  it('どちらも無ければ該当しない', () => {
    assert.equal(isLimitedTimePrice(item()), false);
  });

  it('絞り込みとして効く', () => {
    const items = [item(), item({ priceEndTime: '2026-08-05T23:59:00+09:00' })];
    assert.equal(applyChips(items, new Set(['limitedPrice'])).length, 1);
  });
});

describe('絞り込みの組み合わせ', () => {
  it('複数のチップは AND で効く', () => {
    const items = [
      item({ pointRate: 10, priceEndTime: null }),
      item({ pointRate: 10, priceEndTime: '2026-08-05T23:59:00+09:00' }),
      item({ pointRate: 1, priceEndTime: '2026-08-05T23:59:00+09:00' }),
    ];
    assert.equal(applyChips(items, new Set(['highPoint', 'limitedPrice'])).length, 1);
  });

  it('既存のチップを壊していない', () => {
    for (const id of ['rateBoosted', 'freeShipping', 'inStock', 'rising']) {
      assert.ok(CHIP_FILTERS.some((c) => c.id === id), `${id} が消えている`);
    }
  });
});
