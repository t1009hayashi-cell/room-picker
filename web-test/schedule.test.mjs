import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assignScheduledDate,
  isDuringSale,
  mergeSaleSources,
  resolveScheduledDate,
  salesOnDate,
  SCHEDULE_REASON,
} from '../docs/js/lib/schedule.js';

const SALE = { id: 'auto-1', name: 'セール期間（自動検出）', start: '2026-08-04T20:00:00+09:00', end: '2026-08-11T01:59:00+09:00' };

function item(patch = {}) {
  return { pointRateStart: null, pointRateEnd: null, priceEndTime: null, ...patch };
}

describe('投稿予定日の割当（仕様書 7章）', () => {
  it('優先1: 未到来のポイント倍率開始日を最優先する', () => {
    const r = assignScheduledDate(item({ pointRateStart: '2026-08-06T20:00:00+09:00' }), '2026-08-01', [SALE]);
    assert.equal(r.dateKey, '2026-08-06');
    assert.equal(r.reason, SCHEDULE_REASON.POINT_RATE);
  });

  it('優先2: ポイント期間が無ければ抽出日以降で最も近いセール開始日', () => {
    const r = assignScheduledDate(item(), '2026-08-01', [SALE]);
    assert.equal(r.dateKey, '2026-08-04');
    assert.equal(r.reason, SCHEDULE_REASON.SALE);
  });

  it('優先3: 該当がなければ抽出日の翌日', () => {
    const r = assignScheduledDate(item(), '2026-08-01', []);
    assert.equal(r.dateKey, '2026-08-02');
    assert.equal(r.reason, SCHEDULE_REASON.NEXT_DAY);
  });

  it('到来済みのポイント開始日は採用しない', () => {
    const r = assignScheduledDate(item({ pointRateStart: '2026-07-20T00:00:00+09:00' }), '2026-08-01', []);
    assert.equal(r.dateKey, '2026-08-02');
  });

  it('終了済みのセールは採用しない', () => {
    const past = { ...SALE, start: '2026-07-01T00:00:00+09:00', end: '2026-07-05T00:00:00+09:00' };
    const r = assignScheduledDate(item(), '2026-08-01', [past]);
    assert.equal(r.dateKey, '2026-08-02');
  });

  it('priceEndTime が投稿予定日より前なら翌日に戻し、警告を出す', () => {
    const r = assignScheduledDate(
      item({ pointRateStart: '2026-08-06T20:00:00+09:00', priceEndTime: '2026-08-03T14:59:00+09:00' }),
      '2026-08-01',
      [SALE],
    );
    assert.equal(r.dateKey, '2026-08-02');
    assert.equal(r.reason, SCHEDULE_REASON.NEXT_DAY);
    assert.match(r.priceWarning, /価格/);
  });

  it('投稿予定日中に価格が切れる場合は割当を変えず注意だけ出す', () => {
    const r = assignScheduledDate(item({ priceEndTime: '2026-08-02T14:59:00+09:00' }), '2026-08-01', []);
    assert.equal(r.dateKey, '2026-08-02');
    assert.match(r.priceWarning, /期限が近い/);
  });

  it('手動指定があれば自動再割当をしない', () => {
    const r = resolveScheduledDate(item({ pointRateStart: '2026-08-06T20:00:00+09:00' }), '2026-08-01', [SALE], '2026-08-20');
    assert.equal(r.dateKey, '2026-08-20');
    assert.equal(r.reason, SCHEDULE_REASON.MANUAL);
  });

  it('手動指定日より前に価格が切れる場合は、その日に対して警告を出す', () => {
    const r = resolveScheduledDate(
      item({ priceEndTime: '2026-08-03T14:59:00+09:00' }),
      '2026-08-01',
      [SALE],
      '2026-08-20',
    );
    assert.equal(r.dateKey, '2026-08-20');
    assert.match(r.priceWarning, /価格は 2026-08-03 に終了/);
  });

  it('翌日がすでにセール期間中なら、後ろのセールを待たず翌日に投稿する', () => {
    const ongoing = { id: 's1', name: 'いま開催中', start: '2026-08-01T00:00:00+09:00', end: '2026-08-05T23:59:00+09:00' };
    const later = { id: 's2', name: '次回', start: '2026-08-20T20:00:00+09:00', end: '2026-08-27T01:59:00+09:00' };
    const r = assignScheduledDate(item(), '2026-08-01', [ongoing, later]);
    assert.equal(r.dateKey, '2026-08-02');
    assert.equal(r.reason, SCHEDULE_REASON.NEXT_DAY);
  });

  it('セールが翌日ちょうどに始まる場合、理由は「セール開始日」になる', () => {
    const tomorrow = { id: 's1', name: '明日開始', start: '2026-08-02T20:00:00+09:00', end: '2026-08-09T01:59:00+09:00' };
    const r = assignScheduledDate(item(), '2026-08-01', [tomorrow]);
    assert.equal(r.dateKey, '2026-08-02');
    assert.equal(r.reason, SCHEDULE_REASON.SALE);
  });

  it('すでに価格が切れている商品には「戻しました」と言わない', () => {
    const r = assignScheduledDate(item({ priceEndTime: '2026-08-01T14:59:00+09:00' }), '2026-08-01', []);
    assert.equal(r.dateKey, '2026-08-02');
    assert.equal(r.priceWarning.includes('戻しました'), false);
    assert.match(r.priceWarning, /すでに価格が変わっている/);
  });

  it('セール中でなければ、翌日以降で最も近いセール開始日を選ぶ', () => {
    const first = { id: 's1', name: '近い', start: '2026-08-05T20:00:00+09:00', end: '2026-08-08T23:59:00+09:00' };
    const later = { id: 's2', name: '遠い', start: '2026-08-20T20:00:00+09:00', end: '2026-08-27T01:59:00+09:00' };
    const r = assignScheduledDate(item(), '2026-08-01', [later, first]);
    assert.equal(r.dateKey, '2026-08-05');
    assert.equal(r.reason, SCHEDULE_REASON.SALE);
  });
});

describe('セールのマージと判定（仕様書 5.2 / 8.1）', () => {
  it('同一期間は手動を優先する', () => {
    const manual = { id: 'm1', name: 'お買い物マラソン', start: SALE.start, end: SALE.end };
    const merged = mergeSaleSources([SALE], [manual]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].source, 'manual');
    assert.equal(merged[0].displayName, 'お買い物マラソン');
  });

  it('userLabel があれば表示名に使う', () => {
    const merged = mergeSaleSources([{ ...SALE, userLabel: 'ブランドデー' }], []);
    assert.equal(merged[0].displayName, 'ブランドデー');
  });

  it('セール期間に含まれる日を判定できる', () => {
    const sales = mergeSaleSources([SALE], []);
    assert.equal(salesOnDate(sales, '2026-08-04').length, 1);
    assert.equal(salesOnDate(sales, '2026-08-11').length, 1);
    assert.equal(salesOnDate(sales, '2026-08-12').length, 0);
    assert.equal(salesOnDate(sales, '2026-08-03').length, 0);
  });

  it('投稿時刻がセール期間内かを判定できる', () => {
    assert.equal(isDuringSale([SALE], '2026-08-05T07:12:00+09:00').during, true);
    assert.equal(isDuringSale([SALE], '2026-08-05T07:12:00+09:00').saleId, 'auto-1');
    assert.equal(isDuringSale([SALE], '2026-08-01T07:12:00+09:00').during, false);
  });
});
