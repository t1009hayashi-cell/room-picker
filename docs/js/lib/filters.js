/**
 * 除外条件のクライアント側再評価（仕様書 6.1）。
 *
 * Actions 側は config/scoring.json の既定値で excluded / excludeReasons を付けて保存する。
 * 除外した商品も削除せず残すため、ユーザーが設定画面で閾値を緩めた場合はここで復活させる。
 *
 * 「必須」と書かれた条件（在庫なし・価格の期限切れ・NGワード）は緩められない。
 * 閾値で変わるのは価格・レビュー件数・送料の3つだけ。
 */

import { jstParts } from './format.js';

export const THRESHOLD_REASONS = new Set(['price_below_min', 'review_below_min', 'shipping_fee_separate']);

export const REASON_LABELS = {
  price_below_min: '価格が下限未満',
  review_below_min: 'レビュー件数が下限未満',
  out_of_stock: '在庫なし',
  shipping_fee_separate: '送料別',
  subscription_word: '定期購入・頒布会',
  health_word: '健康訴求語を含む',
  price_expired: '価格の有効期限切れ',
};

/** ユーザー設定を当てはめて、その商品を候補として表示すべきかを返す */
export function isExcludedForUser(item, settings) {
  const reasons = [];

  for (const reason of item.excludeReasons ?? []) {
    if (!THRESHOLD_REASONS.has(reason)) reasons.push(reason);
  }

  // バッチ側（src/filter.ts）と同じ基準にする。価格帯商品は上限、それ以外は表示価格で判定する
  const cutoffPrice = item.hasPriceRange ? item.itemPriceMax : item.itemPrice;
  if (cutoffPrice < settings.minPrice) reasons.push('price_below_min');
  if (item.reviewCount < settings.minReview) reasons.push('review_below_min');
  // postageFlag は 0 が送料込み、1 が送料別
  if (settings.excludeShippingFeeSeparate && item.postageFlag === 1) reasons.push('shipping_fee_separate');

  const unique = [...new Set(reasons)];
  return { excluded: unique.length > 0, reasons: unique };
}

/**
 * ポイント高倍率とみなす下限。
 * 商品カードのバッジ（pointRate >= 5 で「ポイント◯倍」を出す）と同じ基準にする。
 * 基準がずれると、バッジが付いていない商品が絞り込みに残って分かりにくい。
 */
export const HIGH_POINT_RATE = 5;

/**
 * 期間限定価格かどうか。
 *
 * 楽天APIは「割引前の価格」を返さないため、割引そのものは判定できない。
 * 価格の開始・終了日時が設定されている＝期間を切って出している価格、という事実だけが取れる。
 * タイムセールや期間限定の値下げがここに入る。
 */
export function isLimitedTimePrice(item) {
  return Boolean(item.priceEndTime || item.priceStartTime);
}

export const CHIP_FILTERS = [
  { id: 'rateBoosted', label: '料率UPのみ', test: (item) => item.isRateBoosted },
  { id: 'highPoint', label: `ポイント${HIGH_POINT_RATE}倍以上`, test: (item) => (item.pointRate ?? 0) >= HIGH_POINT_RATE },
  { id: 'limitedPrice', label: '期間限定価格', test: isLimitedTimePrice },
  { id: 'freeShipping', label: '送料込みのみ', test: (item) => item.postageFlag === 0 },
  { id: 'inStock', label: '在庫ありのみ', test: (item) => item.availability === 1 },
  { id: 'rising', label: '上昇中のみ', test: (item) => (item.rankChange ?? 0) > 0 || item.isNew },
];

export function applyChips(items, active) {
  if (!active || active.size === 0) return items;
  return items.filter((item) => CHIP_FILTERS.every((f) => !active.has(f.id) || f.test(item)));
}

/**
 * 同日に同一ショップの商品を投稿済みかを調べる（仕様書 8.2）。
 * クリック数はショップ単位でしか取得できないため、同日同ショップが重なると投稿別の分析ができなくなる。
 *
 * 分析が壊れるのは「実際に投稿した日」が重なったときなので、閲覧中の日付ではなく
 * 投稿ログの postedAt（JST）で判定する。
 */
export function sameShopPostedOnDate(posts, shopName, dateKey, excludeItemCode) {
  return posts.filter(
    (post) =>
      post.shopName === shopName &&
      jstParts(post.postedAt)?.dateKey === dateKey &&
      post.itemCode !== excludeItemCode,
  );
}
