import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  judgeCriteria,
  judgeNotInSupermarket,
  judgeOnSale,
  judgePriceTier,
  judgeWellRated,
  type CriteriaInput,
} from '../src/criteria.js';
import type { DiscountInfo, SupermarketRules } from '../src/types.js';
import { config } from './helpers.js';

const noDiscount: DiscountInfo = {
  discountRate: null,
  hasCoupon: false,
  couponDeadlineRaw: null,
  couponDeadline: null,
  priceBefore: null,
  priceAfter: null,
  extractedFrom: null,
  discountExpired: false,
};

function item(patch: Partial<CriteriaInput> = {}): CriteriaInput {
  return {
    itemName: 'コーヒー豆 500g',
    catchcopy: '',
    itemPrice: 5398,
    itemPriceMax: 5398,
    hasPriceRange: false,
    reviewCount: 1981,
    reviewAverage: 4.52,
    discount: noDiscount,
    pointRate: 1,
    newcomerExempt: false,
    ...patch,
  };
}

async function rules(): Promise<SupermarketRules> {
  return (await config()).supermarketRules;
}

describe('価格帯の判定（追加要件v1.3 2章）', () => {
  it('1,000〜3,000円はリーチ枠、それ以外は収益枠', async () => {
    const { scoring } = await config();
    assert.equal(judgePriceTier({ itemPrice: 1180, itemPriceMax: 1180, hasPriceRange: false }, scoring), 'reach');
    assert.equal(judgePriceTier({ itemPrice: 3000, itemPriceMax: 3000, hasPriceRange: false }, scoring), 'reach');
    assert.equal(judgePriceTier({ itemPrice: 3001, itemPriceMax: 3001, hasPriceRange: false }, scoring), 'revenue');
  });

  it('価格帯商品は最大価格で判定する（除外判定と同じ扱い）', async () => {
    const { scoring } = await config();
    // itemPrice 2788 でも上限 8888 なら収益枠として扱う
    assert.equal(judgePriceTier({ itemPrice: 2788, itemPriceMax: 8888, hasPriceRange: true }, scoring), 'revenue');
  });
});

describe('「スーパーにない」の半自動判定（追加要件v1.3 4章）', () => {
  it('大容量を数量から拾う', async () => {
    const r = judgeNotInSupermarket({ itemName: '骨取りサバ 2kg', catchcopy: '' }, await rules());
    assert.equal(r.matched, true);
    assert.ok(r.reason?.includes('2kg'));
  });

  it('必ず「推定」にする。スーパーの品揃えデータは存在しないため', async () => {
    const r = judgeNotInSupermarket({ itemName: '業務用 フランク 50本入', catchcopy: '' }, await rules());
    assert.equal(r.confidence, '推定');
  });

  it('閾値未満の数量は拾わない', async () => {
    // 500g は 1,000g の閾値未満
    const r = judgeNotInSupermarket({ itemName: 'コーヒー豆 500g', catchcopy: '' }, await rules());
    assert.equal(r.matched, false);
  });

  it('無意味な数字を数量として拾わない（実装後の確認項目8章）', async () => {
    for (const name of ['ふりかけ 10%増量', 'カルシウム 50%配合', '2026年 新商品']) {
      const r = judgeNotInSupermarket({ itemName: name, catchcopy: '' }, await rules());
      assert.equal(r.matched, false, `${name} を大容量と誤判定している`);
    }
  });

  it('加工済み・専門店・冷凍も拾う', async () => {
    const r = await rules();
    assert.equal(judgeNotInSupermarket({ itemName: '骨取りサバ切身', catchcopy: '' }, r).matched, true);
    assert.equal(judgeNotInSupermarket({ itemName: 'コーヒー', catchcopy: '自家焙煎' }, r).matched, true);
    assert.equal(judgeNotInSupermarket({ itemName: 'から揚げ', catchcopy: '冷凍便でお届け' }, r).matched, true);
  });

  it('該当しなければ matched: false', async () => {
    const r = judgeNotInSupermarket({ itemName: '醤油 1本', catchcopy: '' }, await rules());
    assert.equal(r.matched, false);
    assert.equal(r.reason, null);
  });
});

describe('「評価が高い」', () => {
  it('件数と評価の両方を満たすと該当', async () => {
    const { scoring } = await config();
    const r = judgeWellRated(item(), scoring);
    assert.equal(r.matched, true);
    assert.equal(r.confidence, '確定');
    assert.ok(r.reason?.includes('4.52'));
  });

  it('件数が多くても評価が低ければ該当しない', async () => {
    const { scoring } = await config();
    assert.equal(judgeWellRated(item({ reviewAverage: 4.1 }), scoring).matched, false);
  });

  it('新着ブーストは評価条件を免除する', async () => {
    const { scoring } = await config();
    const r = judgeWellRated(item({ reviewCount: 60, reviewAverage: 4.0, newcomerExempt: true }), scoring);
    assert.equal(r.matched, true);
    assert.ok(r.reason?.includes('順位上昇中'));
  });
});

describe('「今だけ安い」', () => {
  it('割引率と期限を理由に出す', async () => {
    const { scoring } = await config();
    const r = judgeOnSale(
      item({ discount: { ...noDiscount, discountRate: 50, couponDeadline: '2026-08-22T23:59:00+09:00' } }),
      scoring,
    );
    assert.equal(r.matched, true);
    assert.ok(r.reason?.includes('50%OFF'));
    assert.ok(r.reason?.includes('2026-08-22'));
  });

  it('ポイントは5倍以上のときだけ理由に含める（3〜4倍は説得力がない）', async () => {
    const { scoring } = await config();
    assert.equal(judgeOnSale(item({ pointRate: 4 }), scoring).matched, false);
    assert.equal(judgeOnSale(item({ pointRate: 5 }), scoring).matched, true);
  });

  it('何もなければ該当しない', async () => {
    const { scoring } = await config();
    assert.equal(judgeOnSale(item(), scoring).matched, false);
  });
});

describe('選定基準のまとめ（追加要件v1.3 3.2）', () => {
  it('該当した基準だけを matchedCriteria に並べる', async () => {
    const { scoring } = await config();
    const out = judgeCriteria(
      item({ itemName: '骨取りサバ 2kg', discount: { ...noDiscount, discountRate: 50 } }),
      scoring,
      await rules(),
    );
    assert.deepEqual(out.matchedCriteria, ['スーパーにない', '評価が高い', '今だけ安い']);
    assert.equal(out.priceTier, 'revenue');
  });

  it('どれにも当てはまらない商品は matchedCriteria が空になる', async () => {
    const { scoring } = await config();
    const out = judgeCriteria(item({ itemName: '醤油 1本', reviewAverage: 4.0 }), scoring, await rules());
    assert.deepEqual(out.matchedCriteria, []);
  });

  it('3基準ぶんの判定を必ず持つ（欠けた基準を作らない）', async () => {
    const { scoring } = await config();
    const out = judgeCriteria(item(), scoring, await rules());
    assert.deepEqual(Object.keys(out.criteriaDetail).sort(), ['スーパーにない', '今だけ安い', '評価が高い'].sort());
  });
});
