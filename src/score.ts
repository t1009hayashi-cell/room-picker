import type { DiscountInfo, ItemSource, PointBoost, ScoringConfig } from './types.js';

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

  // 追加要件v1.3 2.3。旧実装は「5,000〜25,000円で+15」で、
  // リーチ枠（1,000〜3,000円）が加点対象外だった。価格帯ごとに分ける。
  // 比率そのものはプール分割で担保するので、ここは各プール内の順序にしか効かない
  const t = scoring.priceTier;
  if (item.itemPrice >= t.reachMin && item.itemPrice <= t.reachMax) {
    score += c.reachPriceBonus;
  } else if (item.itemPrice > t.reachMax && item.itemPrice <= c.revenuePriceMax) {
    score += c.revenuePriceBonus;
  }

  if (item.isRateBoosted) score += c.rateBoostedBonus;

  score += Math.min(item.pointRate, c.pointRateCap);

  return Math.round(score);
}

export interface DealScoreInput {
  discount: DiscountInfo;
  pointBoost: PointBoost;
  /** sales.json と照合した結果、投稿予定日がセール期間中か */
  duringSale: boolean;
}

/**
 * 「今だけ安い」の強さ（追加要件 4章）。hotScore とは別に持つ。
 *
 * **60%OFF はポイント20倍より圧倒的に強い訴求である**ため、割引率を最優先にする。
 * 一覧は hotScore + dealScore の降順で並べる。
 */
export function calcDealScore(item: DealScoreInput, scoring: ScoringConfig): number {
  const d = scoring.dealScore;
  let score = 0;

  // 期限切れの割引は extractDiscount が discountRate を null に戻しているので加点されない
  if ((item.discount.discountRate ?? 0) >= d.discountRateThreshold) score += d.discountBonus;
  if (item.discount.hasCoupon) score += d.couponBonus;

  if (item.pointBoost === 'strong') score += d.pointStrongBonus;
  else if (item.pointBoost === 'weak') score += d.pointWeakBonus;

  if (item.duringSale) score += d.duringSaleBonus;

  return Math.round(score);
}
