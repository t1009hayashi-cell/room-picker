import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calcPointBoost, extractDiscount, resolveDeadline } from '../src/discount.js';
import { calcDealScore } from '../src/score.js';
import { config } from './helpers.js';

const NOW = new Date('2026-08-04T12:00:00+09:00');

function extract(itemName: string, catchcopy = '') {
  return extractDiscount(itemName, catchcopy, NOW);
}

describe('クーポン・割引の抽出（追加要件 2章）', () => {
  it('実データの形をすべて拾える', () => {
    // 追加要件 2.1 に列挙されている実例。期限が生きている時点を基準にする
    // （8月に見ると 7/31 の期限は切れており、割引率は意図的に null になる）
    const july = (name: string) => extractDiscount(name, '', new Date('2026-07-25T12:00:00+09:00'));

    assert.equal(july('【10%OFFクーポン対象 7/31 09:59まで】コカ・コーラ ジョージア').discountRate, 10);
    assert.equal(july('【15%OFFクーポンご利用で4,488円！1本あたり94円以下！7/31 23:59まで】').discountRate, 15);
    assert.equal(july('【今すぐ使える！店内全品45％OFF】').discountRate, 45);
    assert.equal(july('【 7/31 23:59まで 57%OFF + 先着クーポン配布中 】').discountRate, 57);
    assert.equal(july('いまだけ＼半額 50%OFF／').discountRate, 50);
    assert.equal(july('【4,620円→2,992円 +エントリーでP5倍】【35%OFF SALE】').discountRate, 35);
  });

  it('期限切れの販促文が残っている商品は割引率を出さない', () => {
    // 実データには売れ残りの販促文がそのまま残っている商品がある。
    // 8/4 に「7/31まで」と書かれていれば、それは4日前に終わった割引
    const d = extract('【10%OFFクーポン対象 7/31 09:59まで】コカ・コーラ ジョージア');
    assert.equal(d.discountRate, null);
    assert.equal(d.discountExpired, true);
    // クーポンの有無自体は事実として残す
    assert.equal(d.hasCoupon, true);
  });

  it('全角％と半角%の両方に対応する', () => {
    assert.equal(extract('45％OFF').discountRate, 45);
    assert.equal(extract('45%OFF').discountRate, 45);
    assert.equal(extract('45％ オフ').discountRate, 45);
  });

  it('「半額」は50%として扱う', () => {
    assert.equal(extract('いまだけ半額セール').discountRate, 50);
  });

  it('割引以外の％に反応しない（追加要件 9章）', () => {
    // OFF/オフ を伴わない％は割引ではない
    assert.equal(extract('10%増量 お徳用').discountRate, null);
    assert.equal(extract('コラーゲン50%配合').discountRate, null);
    assert.equal(extract('果汁100%ジュース').discountRate, null);
    assert.equal(extract('アルコール度数5%').discountRate, null);
  });

  it('100%OFF は読み違いとして捨てる', () => {
    assert.equal(extract('100%OFF').discountRate, null);
  });

  it('複数の割引率があれば大きい方を採る', () => {
    assert.equal(extract('15%OFFクーポン 併用で最大35%OFF').discountRate, 35);
  });

  it('クーポンの有無を拾う', () => {
    assert.equal(extract('先着クーポン配布中').hasCoupon, true);
    assert.equal(extract('通常価格の商品').hasCoupon, false);
  });

  it('価格変化を拾う。値下げになっていない組み合わせは捨てる', () => {
    const d = extract('【4,620円→2,992円】');
    assert.equal(d.priceBefore, 4620);
    assert.equal(d.priceAfter, 2992);
    // 逆向き（値上げ）は読み違い
    assert.equal(extract('【2,992円→4,620円】').priceBefore, null);
  });

  it('catchcopy からも抽出する', () => {
    const d = extract('ふつうの商品名', '【30%OFF】お買い得');
    assert.equal(d.discountRate, 30);
    assert.equal(d.extractedFrom, 'catchcopy');
  });

  it('itemName を優先する', () => {
    const d = extract('【20%OFF】商品名', '【50%OFF】キャッチコピー');
    assert.equal(d.discountRate, 20);
    assert.equal(d.extractedFrom, 'itemName');
  });

  it('抽出できなかった項目は null（推測して埋めない）', () => {
    const d = extract('ふつうのコーヒー豆 2kg');
    assert.deepEqual(d, {
      discountRate: null,
      hasCoupon: false,
      couponDeadlineRaw: null,
      couponDeadline: null,
      priceBefore: null,
      priceAfter: null,
      extractedFrom: null,
      discountExpired: false,
    });
  });

  it('期限が過去なら discountRate を null に戻し、割引終了の印を立てる', () => {
    // 基準は 2026-08-04。7/31 はすでに過ぎている
    const d = extract('【50%OFF 7/31 23:59まで】');
    assert.equal(d.discountExpired, true);
    assert.equal(d.discountRate, null);
    // 期限そのものは残す（UIに「割引終了」と出すため）
    assert.equal(d.couponDeadlineRaw, '7/31 23:59まで');
  });

  it('期限が未来なら割引率を残す', () => {
    const d = extract('【50%OFF 8/10 23:59まで】');
    assert.equal(d.discountExpired, false);
    assert.equal(d.discountRate, 50);
    assert.equal(d.couponDeadline, '2026-08-10T23:59:00+09:00');
  });
});

describe('期限の年の補完（追加要件 9章）', () => {
  it('年が書かれていないので最も近い未来として解釈する', () => {
    assert.equal(resolveDeadline(8, 10, 23, 59, NOW), '2026-08-10T23:59:00+09:00');
  });

  it('12月に「1/5まで」と書かれていれば翌年と解釈する', () => {
    const dec = new Date('2026-12-20T12:00:00+09:00');
    assert.equal(resolveDeadline(1, 5, 23, 59, dec), '2027-01-05T23:59:00+09:00');
  });

  it('その年の日付が過ぎている場合は過去の値を返す（期限切れとして扱えるように）', () => {
    // 2026-08-04 時点で 7/31 は過去
    assert.equal(resolveDeadline(7, 31, 23, 59, NOW), '2026-07-31T23:59:00+09:00');
  });

  it('存在しない日付は null', () => {
    assert.equal(resolveDeadline(2, 30, 23, 59, NOW), null);
    assert.equal(resolveDeadline(13, 1, 0, 0, NOW), null);
  });

  it('時刻の指定が無ければ 23:59 とみなす', () => {
    const d = extract('【8月10日まで 30%OFF】');
    assert.equal(d.couponDeadline, '2026-08-10T23:59:00+09:00');
  });
});

describe('ポイント倍率の扱い（追加要件 3章）', () => {
  it('5倍以上は strong（投稿文で訴求してよい）', async () => {
    const { scoring } = await config();
    assert.equal(calcPointBoost(5, null, scoring), 'strong');
    assert.equal(calcPointBoost(20, '2026-08-10T23:59:00+09:00', scoring), 'strong');
  });

  it('3〜4倍は weak（候補には入れるが数字を出さない）', async () => {
    const { scoring } = await config();
    assert.equal(calcPointBoost(3, null, scoring), 'weak');
    assert.equal(calcPointBoost(4, null, scoring), 'weak');
  });

  it('1〜2倍は null', async () => {
    const { scoring } = await config();
    assert.equal(calcPointBoost(1, null, scoring), null);
    assert.equal(calcPointBoost(2, null, scoring), null);
  });

  it('pointRateEnd が 9999-12-31 の恒常設定は倍率に関係なく null', async () => {
    const { scoring } = await config();
    // 実データの澤井珈琲ケース
    assert.equal(calcPointBoost(2, '9999-12-31T23:59:00+09:00', scoring), null);
    assert.equal(calcPointBoost(20, '9999-12-31T23:59:00+09:00', scoring), null);
  });
});

describe('dealScore（追加要件 4章）', () => {
  const base = {
    discountRate: null as number | null,
    hasCoupon: false,
    couponDeadlineRaw: null,
    couponDeadline: null,
    priceBefore: null,
    priceAfter: null,
    extractedFrom: null,
    discountExpired: false,
  };

  it('割引20%以上が最も大きい加点（60%OFFはポイント20倍より強い）', async () => {
    const { scoring } = await config();
    const discount = calcDealScore({ discount: { ...base, discountRate: 60 }, pointBoost: null, duringSale: false }, scoring);
    const point = calcDealScore({ discount: { ...base }, pointBoost: 'strong', duringSale: false }, scoring);
    assert.equal(discount, 50);
    assert.equal(point, 20);
    assert.ok(discount > point, '割引がポイントより強くない');
  });

  it('20%未満の割引は加点しない', async () => {
    const { scoring } = await config();
    assert.equal(calcDealScore({ discount: { ...base, discountRate: 15 }, pointBoost: null, duringSale: false }, scoring), 0);
  });

  it('すべて揃うと合算される', async () => {
    const { scoring } = await config();
    const score = calcDealScore(
      { discount: { ...base, discountRate: 60, hasCoupon: true }, pointBoost: 'strong', duringSale: true },
      scoring,
    );
    assert.equal(score, 50 + 30 + 20 + 15);
  });

  it('weak のポイントは弱い加点', async () => {
    const { scoring } = await config();
    assert.equal(calcDealScore({ discount: { ...base }, pointBoost: 'weak', duringSale: false }, scoring), 5);
  });

  it('期限切れの割引は加点されない', async () => {
    const { scoring } = await config();
    // extractDiscount が discountRate を null に戻しているため
    const d = extract('【60%OFF 7/31 23:59まで】');
    assert.equal(calcDealScore({ discount: d, pointBoost: null, duringSale: false }, scoring), 0);
  });
});
