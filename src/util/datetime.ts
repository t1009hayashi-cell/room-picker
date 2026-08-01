/**
 * 日時ユーティリティ。
 *
 * 楽天APIは `2026-08-04 20:00` のようなタイムゾーン無しの文字列をJSTで返す。
 * ホストのタイムゾーンに依存すると GitHub Actions（UTC）とローカル（JST）で結果が変わるため、
 * Date のローカルタイム系メソッドは一切使わず、文字列操作と UTC 系メソッドだけで処理する。
 */

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const RAKUTEN_DT = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/;

function pad(n: number | string, len = 2): string {
  return String(n).padStart(len, '0');
}

/**
 * 楽天APIの日時文字列を ISO 8601（+09:00）に変換する。
 * 空文字・空白のみ・パース不能はすべて null に統一する（仕様書 5.1）。
 */
export function parseRakutenDateTime(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  const m = RAKUTEN_DT.exec(trimmed);
  if (!m) return null;

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = Number(m[6] ?? '0');

  // 2月30日のような存在しない日付を弾く。Date.parse は V8 の寛容な解釈で繰り上げてしまうため、
  // UTC で組み立て直して各要素が一致するかを確認する
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== mo - 1 ||
    probe.getUTCDate() !== d ||
    probe.getUTCHours() !== h ||
    probe.getUTCMinutes() !== mi ||
    probe.getUTCSeconds() !== s
  ) {
    return null;
  }

  return `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}+09:00`;
}

/** UTC基準の Date から JST の YYYY-MM-DD を得る */
export function toJstDateKey(date: Date): string {
  const shifted = new Date(date.getTime() + JST_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** JST の YYYY-MM-DD の 00:00:00+09:00 を表す Date */
export function jstDayStart(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00+09:00`);
}

/** ISO文字列（オフセット付き）から JST の YYYY-MM-DD を得る */
export function isoToJstDateKey(iso: string): string {
  return toJstDateKey(new Date(iso));
}

/** YYYY-MM-DD に日数を加算する（JSTカレンダー上での加算） */
export function addDays(dateKey: string, days: number): string {
  const base = jstDayStart(dateKey);
  return toJstDateKey(new Date(base.getTime() + days * 86400000));
}

/** dateKey 同士の差（b - a）を日数で返す */
export function diffDays(a: string, b: string): number {
  return Math.round((jstDayStart(b).getTime() - jstDayStart(a).getTime()) / 86400000);
}

/** 現在時刻を ISO 8601（+09:00）で返す */
export function nowJstIso(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + JST_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const mo = pad(shifted.getUTCMonth() + 1);
  const d = pad(shifted.getUTCDate());
  const h = pad(shifted.getUTCHours());
  const mi = pad(shifted.getUTCMinutes());
  const s = pad(shifted.getUTCSeconds());
  return `${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`;
}
