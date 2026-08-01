/**
 * 楽天APIの型混在（価格・料率・レビュー平均が文字列で返る）を吸収するパーサ。
 * 仕様書 4.1「すべて明示的にパースすること」に対応する。
 */

/** 数値化。パース不能なら fallback を返す */
export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return fallback;
    // "8,360" のようなカンマ区切りで返る可能性に備える
    const n = Number(trimmed.replace(/,/g, ''));
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/** 数値化。パース不能なら null（値の欠損と 0 を区別したい場合に使う） */
export function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function toStringSafe(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

/** hasPriceRange など 0/1 で返るフラグを boolean にする */
export function toBooleanFlag(value: unknown): boolean {
  return toNumber(value, 0) === 1;
}

/**
 * `affiliateRate` を小数に変換する。`"4.0"` → 0.04（仕様書 4.1 / 6.2）。
 * 欠損・0 のときは null を返し、呼び出し側で genres.json のフォールバックを使う。
 */
export function parseAffiliateRate(value: unknown): number | null {
  const n = toNumberOrNull(value);
  if (n === null || n <= 0) return null;
  return n / 100;
}
