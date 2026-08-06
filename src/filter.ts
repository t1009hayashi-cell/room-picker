import type { ExcludeReasonCode, NgWordsConfig, ScoringConfig } from './types.js';

export interface FilterInput {
  itemName: string;
  itemPrice: number;
  itemPriceMax: number;
  hasPriceRange: boolean;
  reviewCount: number;
  reviewAverage: number;
  availability: number;
  postageFlag: number;
  priceEndTime: string | null;
  /** 新着ブーストの判定に使う。前日データが無い初回は null */
  rankChange: number | null;
}

export interface FilterResult {
  excluded: boolean;
  excludeReason: string | null;
  excludeReasons: ExcludeReasonCode[];
  /** レビュー平均の条件を免除したか（追加要件 1.2） */
  newcomerExempt: boolean;
}

export const EXCLUDE_REASON_LABELS: Record<ExcludeReasonCode, string> = {
  price_below_min: '価格が下限未満',
  review_below_min: 'レビュー件数が下限未満',
  review_average_below_min: 'レビュー平均が下限未満',
  out_of_stock: '在庫なし',
  shipping_fee_separate: '送料別',
  subscription_word: '定期購入・頒布会',
  health_word: '健康訴求語を含む',
  price_expired: '価格の有効期限切れ',
};

/**
 * 新着ブースト（追加要件 1.2）。
 * レビュー件数が一定以上あり、かつ順位が上がっている商品はレビュー平均の条件を免除する。
 * 注目され始めた商品はレビューが溜まっていないだけで、定番より投稿の希少価値が高いため。
 */
export function isNewcomer(
  item: Pick<FilterInput, 'reviewCount' | 'rankChange'>,
  scoring: ScoringConfig,
): boolean {
  const n = scoring.filters.newcomer;
  if (item.reviewCount < n.minReviewCount) return false;
  // 前日データが無い初回実行では順位変動が出ないため免除しない（仕様書 6.4 と同じ考え方）
  return (item.rankChange ?? 0) >= n.minRankChange;
}

export function containsAny(text: string, words: string[]): string | null {
  for (const word of words) {
    if (word !== '' && text.includes(word)) return word;
  }
  return null;
}

/**
 * 仕様書 6.1 の除外条件。
 * 除外した商品は削除せず excluded / excludeReason を付けて残す（閾値を緩めたときに再利用するため）。
 *
 * @param earliestPostingDate 最短の投稿予定日（＝抽出日の翌日）の 00:00+09:00。
 *   仕様書 6.1 は「priceEndTime が投稿予定日より前」を必須除外とするが、投稿予定日はユーザーが
 *   変更しうるため、ここでは最短の投稿予定日で判定する。それより後ろの日付に割り当てた場合の
 *   期限切れは仕様書7章に従い UI 側で「価格の期限が近い」警告と再割当で扱う。
 */
export function evaluateExclusion(
  item: FilterInput,
  scoring: ScoringConfig,
  ngWords: NgWordsConfig,
  earliestPostingDate: Date,
): FilterResult {
  const reasons: ExcludeReasonCode[] = [];
  const f = scoring.filters;

  // 価格帯商品の足切りは itemPriceMax を使う。itemPrice で切るとランキング上位を取り逃す（仕様書 6.1）。
  // 価格帯でない商品は「表示価格は itemPrice を正とする」に従い itemPrice で判定する。
  // itemPriceMax を一律に使うと、itemPrice と min/max が食い違う商品（実データに存在）で
  // 表示価格が閾値未満なのに通過してしまう。
  const cutoffPrice = item.hasPriceRange ? item.itemPriceMax : item.itemPrice;
  if (cutoffPrice < f.minPrice) reasons.push('price_below_min');

  if (item.reviewCount < f.minReviewCount) reasons.push('review_below_min');

  // レビュー平均で実質の品質を見る（追加要件 1章）。
  // 件数は十分でも評価が低い商品は、実際に不満が出ているサインとして弾く。
  // ただし新着ブーストに該当する商品はこの条件を免除する（追加要件 1.2）。
  const newcomerExempt = isNewcomer(item, scoring);
  if (!newcomerExempt && item.reviewAverage > 0 && item.reviewAverage < f.minReviewAverage) {
    reasons.push('review_average_below_min');
  }

  // availability: 0 = 売り切れ
  if (f.excludeOutOfStock && item.availability === 0) reasons.push('out_of_stock');

  // postageFlag: 0 = 送料込み / 1 = 送料別。値の意味が直感と逆（仕様書 4.1 / 6.1）
  if (f.excludeShippingFeeSeparate && item.postageFlag === 1) reasons.push('shipping_fee_separate');

  if (containsAny(item.itemName, ngWords.subscription)) reasons.push('subscription_word');
  if (containsAny(item.itemName, ngWords.health)) reasons.push('health_word');

  if (item.priceEndTime !== null) {
    const end = Date.parse(item.priceEndTime);
    if (!Number.isNaN(end) && end < earliestPostingDate.getTime()) reasons.push('price_expired');
  }

  const first = reasons[0];
  return {
    excluded: reasons.length > 0,
    excludeReason: first ? EXCLUDE_REASON_LABELS[first] : null,
    excludeReasons: reasons,
    newcomerExempt,
  };
}
