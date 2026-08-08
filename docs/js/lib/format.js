/**
 * 表示整形と日付ユーティリティ。
 * 日付は Actions 側と同じく JST 固定で扱う。端末のタイムゾーンに依存させない。
 */

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const pad = (n, len = 2) => String(n).padStart(len, '0');

export function toDateKey(date) {
  const s = new Date(date.getTime() + JST_OFFSET_MS);
  return `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}`;
}

export function dayStart(dateKey) {
  return new Date(`${dateKey}T00:00:00+09:00`);
}

export function todayKey(now = new Date()) {
  return toDateKey(now);
}

export function addDays(dateKey, days) {
  return toDateKey(new Date(dayStart(dateKey).getTime() + days * 86400000));
}

export function isoToDateKey(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : toDateKey(new Date(t));
}

export function monthKey(dateKey) {
  return dateKey.slice(0, 7);
}

/** 現在時刻を JST の ISO 8601（+09:00）で返す。投稿ログの postedAt に使う */
export function nowJstIso(now = new Date()) {
  const s = new Date(now.getTime() + JST_OFFSET_MS);
  return (
    `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}` +
    `T${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}:${pad(s.getUTCSeconds())}+09:00`
  );
}

/**
 * ISO文字列を JST の日付要素に分解する。
 * 端末のタイムゾーンに依存する getDay() / getHours() を集計に使わないための土台。
 */
export function jstParts(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const s = new Date(t + JST_OFFSET_MS);
  return {
    dateKey: `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}`,
    dow: s.getUTCDay(),
    hour: s.getUTCHours(),
  };
}

/** その月の1日から末日までの dateKey 配列 */
export function monthDates(year, month) {
  const out = [];
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d = 1; d <= last; d += 1) out.push(`${year}-${pad(month)}-${pad(d)}`);
  return out;
}

/** 日曜始まりの6週グリッド（前後の月の日を含む） */
export function calendarGrid(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const lead = first.getUTCDay();
  const start = new Date(first.getTime() - lead * 86400000);
  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(start.getTime() + i * 86400000);
    const key = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    cells.push({ dateKey: key, inMonth: d.getUTCMonth() + 1 === month, dow: d.getUTCDay() });
  }
  return cells;
}

export const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

export function weekdayOf(dateKey) {
  // UTC の 00:00 として読むことで、端末のタイムゾーンに関係なく曜日が一致する
  return WEEKDAY_JA[new Date(`${dateKey}T00:00:00Z`).getUTCDay()];
}

export function fmtYen(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${Math.round(value).toLocaleString('ja-JP')}円`;
}

export function fmtNum(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Number(value).toLocaleString('ja-JP');
}

export function fmtPercent(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function fmtDateShort(dateKey) {
  if (!dateKey) return '—';
  const [, m, d] = dateKey.split('-');
  return `${Number(m)}/${Number(d)}`;
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const s = new Date(t + JST_OFFSET_MS);
  return `${s.getUTCFullYear()}/${pad(s.getUTCMonth() + 1)}/${pad(s.getUTCDate())} ${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}`;
}

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function charLength(text) {
  return Array.from(String(text ?? '')).length;
}

/**
 * ヘッダー（1行目）の文字数帯（仕様書 10.4）。
 * 投稿プロンプトの推奨は20〜30文字（実測で上位10位の平均が32文字）。
 * その前後で分かれるように区切る。
 */
export function firstLineBand(length) {
  if (length <= 19) return '〜19';
  if (length <= 30) return '20〜30';
  return '31〜';
}

export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
