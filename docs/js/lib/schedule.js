/**
 * 投稿予定日の割当（仕様書 7章）。
 *
 * 優先順位
 *  1. その商品に pointRateStart があり、まだ到来していない場合はその開始日
 *  2. 自動検出または手動登録されたセールの開始日で、抽出日以降の最も近いもの
 *  3. 該当がなければ抽出日の翌日
 *
 * ただし priceEndTime が投稿予定日より前になる場合は、割当を抽出日の翌日に戻し、
 * 「価格の期限が近い」旨を UI に表示する。
 *
 * ユーザーが手動変更した場合は自動再割当をしない（呼び出し側が保存値を優先する）。
 */

import { addDays, dayStart, isoToDateKey } from './format.js';

export const SCHEDULE_REASON = {
  POINT_RATE: 'この商品のポイント倍率が上がる日',
  SALE: 'セール開始日',
  NEXT_DAY: '抽出日の翌日',
  MANUAL: '手動で指定',
};

/**
 * @param {object} item 正規化済み商品
 * @param {string} discoveredDate 抽出日 YYYY-MM-DD
 * @param {Array<{start:string,end:string}>} sales セール一覧（自動＋手動をマージ済み）
 */
export function assignScheduledDate(item, discoveredDate, sales = []) {
  const nextDay = addDays(discoveredDate, 1);
  let dateKey = nextDay;
  let reason = SCHEDULE_REASON.NEXT_DAY;

  const pointStart = isoToDateKey(item.pointRateStart);
  if (pointStart && pointStart >= nextDay) {
    // 商品ごとのポイント期間を最優先する（その商品が最も売れやすい日を商品自身が持っているため）
    dateKey = pointStart;
    reason = SCHEDULE_REASON.POINT_RATE;
  } else {
    const candidates = sales
      .map((sale) => isoToDateKey(sale.start))
      .filter((key) => key && key >= nextDay)
      .sort();

    if (candidates[0] === nextDay) {
      // 翌日にセールが始まる。日付は翌日と同じでも、理由はセール開始日として扱う
      dateKey = nextDay;
      reason = SCHEDULE_REASON.SALE;
    } else if (salesOnDate(sales, nextDay).length > 0) {
      // 翌日がすでにセール期間中なら、後ろのセールを待たず翌日に投稿する
      dateKey = nextDay;
      reason = SCHEDULE_REASON.NEXT_DAY;
    } else if (candidates.length > 0) {
      dateKey = candidates[0];
      reason = SCHEDULE_REASON.SALE;
    }
  }

  const expiry = checkPriceExpiry(item, dateKey);
  if (expiry.expiredBefore) {
    // 仕様書7章: 割当を抽出日の翌日に戻し、価格の期限が近い旨を表示する。
    // もともと翌日だった場合は「戻した」わけではないので、文言を分ける
    const movedBack = dateKey !== nextDay;
    return {
      dateKey: nextDay,
      reason: SCHEDULE_REASON.NEXT_DAY,
      priceWarning: movedBack
        ? `${expiry.warning}。投稿予定日を翌日に戻しました`
        : `${expiry.warning}。すでに価格が変わっている可能性があります`,
    };
  }

  return { dateKey, reason, priceWarning: expiry.warning };
}

/** priceEndTime が指定日より前／その日のうちに切れるかを調べる */
function checkPriceExpiry(item, dateKey) {
  if (!item.priceEndTime) return { expiredBefore: false, warning: null };
  const endMs = Date.parse(item.priceEndTime);
  if (Number.isNaN(endMs)) return { expiredBefore: false, warning: null };

  if (endMs < dayStart(dateKey).getTime()) {
    return {
      expiredBefore: true,
      warning: `この価格は ${isoToDateKey(item.priceEndTime)} に終了します（投稿予定日より前）`,
    };
  }
  if (endMs < dayStart(addDays(dateKey, 1)).getTime()) {
    return { expiredBefore: false, warning: '価格の期限が近いです（投稿予定日中に終了）' };
  }
  return { expiredBefore: false, warning: null };
}

/**
 * 保存済みの手動指定があればそれを優先する（自動再割当はしない）。
 * ただし価格の期限判定は「手動で選んだ日」に対して行う。自動割当時の警告を流用すると、
 * 価格が切れた後の日を手動で選んでも警告が出ない。
 */
export function resolveScheduledDate(item, discoveredDate, sales, manualDate) {
  if (manualDate) {
    const expiry = checkPriceExpiry(item, manualDate);
    return {
      dateKey: manualDate,
      reason: SCHEDULE_REASON.MANUAL,
      priceWarning: expiry.expiredBefore
        ? `${expiry.warning}。この日に投稿しても価格は変わっています`
        : expiry.warning,
    };
  }
  return assignScheduledDate(item, discoveredDate, sales);
}

/** 自動検出セールと手動セールをマージする。重複時は手動を優先する（仕様書 5.2） */
export function mergeSaleSources(autoSales = [], manualSales = [], labels = {}) {
  const sameSpan = (a, b) => Date.parse(a.start) === Date.parse(b.start) && Date.parse(a.end) === Date.parse(b.end);
  const merged = [...manualSales.map((s) => ({ ...s, source: 'manual' }))];
  for (const auto of autoSales) {
    if (!merged.some((m) => sameSpan(m, auto))) merged.push({ ...auto, source: 'auto' });
  }
  return merged
    .map((sale) => ({ ...sale, displayName: labels[sale.id] ?? sale.userLabel ?? sale.name }))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** dateKey がセール期間に含まれるか */
export function salesOnDate(sales, dateKey) {
  const dayStartMs = dayStart(dateKey).getTime();
  const dayEndMs = dayStartMs + 86400000 - 1;
  return sales.filter((sale) => {
    const s = Date.parse(sale.start);
    const e = Date.parse(sale.end);
    return !Number.isNaN(s) && !Number.isNaN(e) && s <= dayEndMs && e >= dayStartMs;
  });
}

export function isDuringSale(sales, iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { during: false, saleId: null };
  const hit = sales.find((sale) => Date.parse(sale.start) <= t && t <= Date.parse(sale.end));
  return { during: Boolean(hit), saleId: hit?.id ?? null };
}
