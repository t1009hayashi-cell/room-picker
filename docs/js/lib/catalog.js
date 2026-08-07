/**
 * 読み込んだ日次スナップショットを、カレンダー／日別リストが引きやすい形に組み替える。
 *
 * 同じ商品が複数日のランキングに載るため、投稿予定日モードでは itemCode で重複を除き、
 * 最新の抽出日のデータを採用する（価格・順位が最も新しいため）。
 * 発見日モードは日ごとの記録そのものなので重複を除かない。
 */

import { flattenSnapshot } from './dataLoader.js';
import { isExcludedForUser } from './filters.js';
import { resolveScheduledDate } from './schedule.js';
import { dayItemKey } from './store.js';

export function buildCatalog({ snapshots, sales, settings, schedule }) {
  const byDiscovered = new Map();
  const latestByCode = new Map();

  const enabled = settings.genreEnabled ?? {};
  const dates = [...snapshots.keys()].sort();
  for (const dateKey of dates) {
    const items = flattenSnapshot(snapshots.get(dateKey))
      // 設定画面で明示的に無効化されたジャンルは表示しない（既定は有効）
      .filter((item) => enabled[item.genreId] !== false)
      .map((item) => decorate(item, sales, settings, schedule));
    byDiscovered.set(dateKey, items);
    for (const item of items) latestByCode.set(item.itemCode, item);
  }

  const byScheduled = new Map();
  for (const item of latestByCode.values()) {
    if (item.userExcluded) continue;
    const key = item.scheduledDate;
    if (!byScheduled.has(key)) byScheduled.set(key, []);
    byScheduled.get(key).push(item);
  }

  for (const list of byScheduled.values()) list.sort((a, b) => b.hotScore - a.hotScore);
  for (const list of byDiscovered.values()) list.sort((a, b) => b.hotScore - a.hotScore);

  return { byDiscovered, byScheduled, latestByCode, dates };
}

function decorate(item, sales, settings, schedule) {
  const userExclusion = isExcludedForUser(item, settings);
  const resolved = resolveScheduledDate(item, item.discoveredDate, sales, schedule[item.itemCode] ?? null);
  return {
    ...item,
    userExcluded: userExclusion.excluded,
    userExcludeReasons: userExclusion.reasons,
    scheduledDate: resolved.dateKey,
    scheduleReason: resolved.reason,
    priceWarning: resolved.priceWarning,
  };
}

/**
 * カレンダーの日付セルに出す集計（仕様書 8.1）。
 *
 * 投稿済み・予約は「日付|itemCode」で記録されているため dateKey が要る。
 * 商品コードだけで見ると、同じ商品が載っている他の日にも印が付いてしまう。
 */
export function summarizeDay(
  items,
  dateKey,
  { posted: postedMap = {}, reserved: reservedMap = {} } = {},
  postedIndex = new Map(),
) {
  let todo = 0;
  let posted = 0;
  let reserved = 0;
  let rateBoosted = 0;
  let reward = 0;

  for (const item of items) {
    const key = dayItemKey(dateKey, item.itemCode);
    if (postedMap[key]) posted += 1;
    // 別の日に投稿済みの商品は「やること」に数えない。
    // 数えると、同じ商品が複数の日に出るぶんだけ件数が水増しされる
    else if (!postedIndex.has(item.itemCode)) todo += 1;
    // 予約は「投稿文を書いて当日に備えた」印。投稿すると解除されるので posted とは重ならない
    if (reservedMap[key]) reserved += 1;
    if (item.isRateBoosted) rateBoosted += 1;
    reward += item.estimatedReward ?? 0;
  }
  return { total: items.length, todo, posted, reserved, rateBoosted, reward };
}
