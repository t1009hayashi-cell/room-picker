import type { DailySnapshot } from './types.js';

export interface PrevRankIndex {
  /** 前日スナップショットが存在したか。無い場合は上昇幅ボーナスを付けない（仕様書 6.4） */
  hasPrevSnapshot: boolean;
  ranks: Map<string, number>;
}

/**
 * 仕様書 6.4。前日のJSONが存在しない場合（初回実行、Actions失敗時）は
 * prevRank: null / isNew: true / 上昇幅ボーナスなし として扱い、エラーにしない。
 */
export function buildPrevRankIndex(prev: DailySnapshot | null): PrevRankIndex {
  const ranks = new Map<string, number>();
  if (!prev) return { hasPrevSnapshot: false, ranks };

  for (const genre of prev.genres) {
    for (const item of genre.items) {
      if (item.rank === null) continue;
      const existing = ranks.get(item.itemCode);
      // 同一商品が複数ジャンルに載る場合は上位（数値の小さい方）を採用する
      if (existing === undefined || item.rank < existing) ranks.set(item.itemCode, item.rank);
    }
  }
  return { hasPrevSnapshot: true, ranks };
}

export interface RankDiff {
  prevRank: number | null;
  rankChange: number | null;
  isNew: boolean;
}

export function calcRankDiff(
  itemCode: string,
  rank: number | null,
  source: 'ranking' | 'search',
  index: PrevRankIndex,
): RankDiff {
  if (source !== 'ranking' || rank === null) {
    // 検索API由来は順位を持たない。NEW 扱いにもしない（仕様書 6.3）
    return { prevRank: null, rankChange: null, isNew: false };
  }
  const prevRank = index.ranks.get(itemCode) ?? null;
  if (prevRank === null) {
    return { prevRank: null, rankChange: null, isNew: true };
  }
  return { prevRank, rankChange: prevRank - rank, isNew: false };
}
