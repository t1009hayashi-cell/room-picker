import type { ItemSource, ScoringConfig } from './types.js';

export interface ScoreInput {
  source: ItemSource;
  rank: number | null;
  prevRank: number | null;
  isNew: boolean;
  /** 前日のスナップショットが存在したか。無い場合は上昇幅ボーナスを付けない（仕様書 6.4） */
  hasPrevSnapshot: boolean;
  reviewCount: number;
  itemPrice: number;
  isRateBoosted: boolean;
  pointRate: number;
}

/**
 * 仕様書 6.3 の hotScore。順位変動を主、規模を従とする。
 * 係数はすべて config/scoring.json（1箇所）に集約している。
 */
export function calcHotScore(item: ScoreInput, scoring: ScoringConfig): number {
  const c = scoring.hotScore;
  let score = 0;

  // 検索API由来は順位を持たないため上昇幅の項は0（仕様書 6.3）
  if (item.source === 'ranking' && item.rank !== null) {
    if (item.prevRank !== null) {
      score += (item.prevRank - item.rank) * c.rankGainPerRank;
    } else if (item.hasPrevSnapshot) {
      // 前日データがある上で載っていなかった＝真の新規ランクイン
      score += c.newEntryBonus;
    }
    // hasPrevSnapshot が false（初回実行・Actions失敗）は加点しない（仕様書 6.4）
  }

  score += Math.min(item.reviewCount / c.reviewDivisor, c.reviewCap);

  if (item.itemPrice >= c.priceSweetSpotMin && item.itemPrice <= c.priceSweetSpotMax) {
    score += c.priceSweetSpotBonus;
  }

  if (item.isRateBoosted) score += c.rateBoostedBonus;

  score += Math.min(item.pointRate, c.pointRateCap);

  return Math.round(score);
}
