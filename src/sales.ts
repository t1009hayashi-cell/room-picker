import type { NormalizedItem, SaleEntry, ScoringConfig } from './types.js';
import { isoToJstDateKey, parseRakutenDateTime } from './util/datetime.js';

/** ISO文字列を `YYYYMMDDHHMM` に潰す（id生成用） */
function compactStamp(iso: string): string {
  return `${isoToJstDateKey(iso).replace(/-/g, '')}${iso.slice(11, 16).replace(':', '')}`;
}

export interface SaleCandidateInput {
  shopCode: string;
  pointRateStart: string | null;
  pointRateEnd: string | null;
}

/**
 * 仕様書 5.2。pointRateStartTime / pointRateEndTime からセール期間を自動推定する。
 *
 * 誤検出対策として次の条件を「すべて」満たす組だけを採用する。
 *  1. 3件以上の異なる shopCode の商品で出現する
 *  2. 終了日時が無期限マーカー（9999-12-31 23:59）でない
 *  3. 期間が maxDurationDays 以内
 *  4. 終了日時が未来
 *
 * 1 と 2 は必須。実データで同一ショップ5件が 9999-12-31 まで続く恒常設定を持っていたため。
 */
export function detectSales(
  items: SaleCandidateInput[],
  scoring: ScoringConfig,
  now: Date = new Date(),
): SaleEntry[] {
  const cfg = scoring.sales;
  const infiniteEndIso = parseRakutenDateTime(cfg.infiniteEndMarker);

  const groups = new Map<string, { start: string; end: string; shops: Set<string>; count: number }>();

  for (const item of items) {
    const { pointRateStart: start, pointRateEnd: end, shopCode } = item;
    if (!start || !end) continue;

    const key = `${start}__${end}`;
    let group = groups.get(key);
    if (!group) {
      group = { start, end, shops: new Set<string>(), count: 0 };
      groups.set(key, group);
    }
    if (shopCode !== '') group.shops.add(shopCode);
    group.count += 1;
  }

  const maxDurationMs = cfg.maxDurationDays * 86400000;
  const nowMs = now.getTime();
  const sales: SaleEntry[] = [];

  for (const group of groups.values()) {
    // 条件2: 無期限マーカーはショップ独自の恒常的なポイント設定であってセールではない
    if (infiniteEndIso !== null && group.end === infiniteEndIso) continue;

    const startMs = Date.parse(group.start);
    const endMs = Date.parse(group.end);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;

    // 条件1: 同一ショップ内の重複を除いた実数で数える
    if (group.shops.size < cfg.minDistinctShops) continue;
    // 条件3
    if (endMs - startMs > maxDurationMs || endMs < startMs) continue;
    // 条件4
    if (endMs <= nowMs) continue;

    sales.push({
      // 同じ日に始まり同じ日に終わる別時間帯の期間が併存しうるため、時刻まで id に含める
      id: `auto-${compactStamp(group.start)}-${compactStamp(group.end)}`,
      name: 'セール期間（自動検出）', // 正式名称は推測しない（仕様書 5.2）
      start: group.start,
      end: group.end,
      itemCount: group.count,
      source: 'auto',
      userLabel: null,
    });
  }

  sales.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
  return sales;
}

export function collectSaleInputs(items: NormalizedItem[]): SaleCandidateInput[] {
  return items.map((item) => ({
    shopCode: item.shopCode,
    pointRateStart: item.pointRateStart,
    pointRateEnd: item.pointRateEnd,
  }));
}

/**
 * 既存の sales.json とマージする。
 * 自動検出と手動登録が重複した場合は手動を優先する（仕様書 5.2）。
 * 自動検出分は再生成のたびに置き換えるが、ユーザーが付けた userLabel は引き継ぐ。
 */
export function mergeSales(previous: SaleEntry[], detected: SaleEntry[]): SaleEntry[] {
  const manual = previous.filter((s) => s.source === 'manual');
  const prevAutoById = new Map(previous.filter((s) => s.source === 'auto').map((s) => [s.id, s]));

  const overlapsManual = (sale: SaleEntry): boolean =>
    manual.some((m) => Date.parse(m.start) === Date.parse(sale.start) && Date.parse(m.end) === Date.parse(sale.end));

  const autos = detected
    .filter((sale) => !overlapsManual(sale))
    .map((sale) => ({ ...sale, userLabel: prevAutoById.get(sale.id)?.userLabel ?? null }));

  return [...manual, ...autos].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}
