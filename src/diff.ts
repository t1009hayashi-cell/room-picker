import type { ItemSource, DailySnapshot } from './types.js';

export interface PrevRankIndex {
  /** 前日スナップショットが存在したか。無い場合は上昇幅ボーナスを付けない（仕様書 6.4） */
  hasPrevSnapshot: boolean;
  ranks: Map<string, number>;
  /** 前日のレビュー件数。「直近でどれだけ伸びているか」を出すために持つ */
  reviewCounts: Map<string, number>;
}

/**
 * 仕様書 6.4。前日のJSONが存在しない場合（初回実行、Actions失敗時）は
 * prevRank: null / isNew: true / 上昇幅ボーナスなし として扱い、エラーにしない。
 */
export function buildPrevRankIndex(prev: DailySnapshot | null): PrevRankIndex {
  const ranks = new Map<string, number>();
  const reviewCounts = new Map<string, number>();
  if (!prev) return { hasPrevSnapshot: false, ranks, reviewCounts };

  for (const genre of prev.genres) {
    for (const item of genre.items) {
      // レビュー件数は順位を持たない検索API由来の商品でも比べられる
      const prevCount = reviewCounts.get(item.itemCode);
      if (prevCount === undefined || item.reviewCount > prevCount) {
        reviewCounts.set(item.itemCode, item.reviewCount);
      }

      if (item.rank === null) continue;
      const existing = ranks.get(item.itemCode);
      // 同一商品が複数ジャンルに載る場合は上位（数値の小さい方）を採用する
      if (existing === undefined || item.rank < existing) ranks.set(item.itemCode, item.rank);
    }
  }
  return { hasPrevSnapshot: true, ranks, reviewCounts };
}

export interface ReviewDiff {
  prevReviewCount: number | null;
  /** 前日からの増加数。前日データが無ければ null（0と区別する） */
  reviewCountChange: number | null;
}

/**
 * レビュー件数の増加。
 * 「いま人気が出ている商品」を見分ける材料。順位変動と違い検索API由来でも出せる。
 * 前日データが無い初回は null にして、0件増と区別できるようにする（仕様書 6.4 と同じ考え方）。
 */
export function calcReviewDiff(itemCode: string, reviewCount: number, index: PrevRankIndex): ReviewDiff {
  if (!index.hasPrevSnapshot) return { prevReviewCount: null, reviewCountChange: null };
  const prev = index.reviewCounts.get(itemCode);
  if (prev === undefined) return { prevReviewCount: null, reviewCountChange: null };
  return { prevReviewCount: prev, reviewCountChange: reviewCount - prev };
}

export interface RankDiff {
  prevRank: number | null;
  rankChange: number | null;
  isNew: boolean;
}

export function calcRankDiff(
  itemCode: string,
  rank: number | null,
  source: ItemSource,
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
