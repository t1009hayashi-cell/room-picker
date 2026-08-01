import type { ScoringConfig } from './types.js';

export interface RewardInput {
  itemPrice: number;
  itemPriceMin: number;
  hasPriceRange: boolean;
  affiliateRate: number;
  isRateBoosted: boolean;
}

export interface RewardResult {
  estimatedReward: number;
  /** 上限1,000円が実際に効いたか。UIで区別表示する（仕様書 8.2） */
  rewardCapApplied: boolean;
  /** 算出に使った価格。UIで「〜円から」の表示判断に使う */
  basePrice: number;
}

/**
 * 仕様書 6.2 の想定報酬。
 *
 *   estimatedReward = min(price × rate, 1000) + min(price × ROOMランクボーナス率, 1000)
 *
 * ただし affiliateRate が 5% 以上（isRateBoosted）の商品は1商品1,000円の上限も
 * 同一ユーザー月3,000円の上限も対象外のため、上限を適用しない。
 * 上限を適用すると報酬を過小評価する。
 */
export function calcEstimatedReward(item: RewardInput, scoring: ScoringConfig): RewardResult {
  const { rewardCapPerItem, roomRankBonusRate, roomRankBonusCap } = scoring.reward;

  // 価格帯商品は下限価格で保守的に見積もる（仕様書 6.1 / 6.2）
  const basePrice = item.hasPriceRange ? item.itemPriceMin : item.itemPrice;

  const rawBase = basePrice * item.affiliateRate;
  const rawBonus = basePrice * roomRankBonusRate;

  if (item.isRateBoosted) {
    return {
      estimatedReward: Math.round(rawBase + rawBonus),
      rewardCapApplied: false,
      basePrice,
    };
  }

  const cappedBase = Math.min(rawBase, rewardCapPerItem);
  const cappedBonus = Math.min(rawBonus, roomRankBonusCap);
  return {
    estimatedReward: Math.round(cappedBase + cappedBonus),
    rewardCapApplied: rawBase > rewardCapPerItem || rawBonus > roomRankBonusCap,
    basePrice,
  };
}
