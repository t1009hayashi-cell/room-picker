/**
 * 商品を手動で足す（追加要件v1.3 5章）。
 *
 * **なぜ必要か。**
 * 候補一覧に出てこない商品を投稿することがあり、その投稿ログが残らないと
 * 分析から漏れる。分析の前提は「投稿した全件が記録されていること」で、
 * 一部が欠けると比率も平均も正しく出せない。
 *
 * **楽天APIを直接叩く形（5.2 手順3）はここでは実装していない。**
 * アプリIDとアクセスキーは公開リポジトリに置けず、静的サイトからAPIを呼ぶと
 * 必ず認証情報が露出する。取得はバッチ（GitHub Actions）側の役目であり、
 * ここでは 5.4 の「最小限の手入力」だけを行う。
 * そのため作ったレコードには常に `dataSource: 'manual-input'` が立ち、
 * **選定ロジックの検証には使わない**（データの質が違うため）。
 */

import { priceTierOf } from './pools.js';

/**
 * 楽天の商品URLから itemCode を取り出す。
 * 形式：`https://item.rakuten.co.jp/{shopCode}/{itemId}/`
 * 計測パラメータやモバイル用ドメイン（`item.rakuten.co.jp` 以外）も来るので緩めに見る。
 */
export function parseItemUrl(url) {
  const text = String(url ?? '').trim();
  if (text === '') return { ok: false, error: 'URLが空です' };

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, error: 'URLとして読めません。楽天の商品ページのURLを貼ってください' };
  }
  if (!/(^|\.)rakuten\.co\.jp$/u.test(parsed.hostname)) {
    return { ok: false, error: `楽天のURLではありません（${parsed.hostname}）` };
  }

  const parts = parsed.pathname.split('/').filter((p) => p !== '');
  if (parts.length < 2) {
    return { ok: false, error: 'ショップと商品IDが読み取れません。商品ページのURLを貼ってください' };
  }
  const [shopCode, itemId] = parts;
  return {
    ok: true,
    shopCode,
    itemId,
    itemCode: `${shopCode}:${itemId}`,
    // 計測パラメータを落とした正規のURL
    itemUrl: `https://item.rakuten.co.jp/${shopCode}/${itemId}/`,
  };
}

/**
 * 手入力の内容から、候補一覧の商品と同じ形のレコードを作る。
 *
 * 5.3 のとおり**除外条件に該当しても除外しない。** ユーザーが意図して選んだものなので
 * 判断を上書きしない。該当した理由は警告として持たせ、カードに出す。
 */
export function buildManualItem(input, settings) {
  const price = Number(input.itemPrice);
  const reviewCount = Number(input.reviewCount ?? 0) || 0;
  const reviewAverage = Number(input.reviewAverage ?? 0) || 0;

  const warnings = [];
  if (price < (settings.minPrice ?? 1000)) warnings.push(`価格${price.toLocaleString('en-US')}円（下限${settings.minPrice}円未満）`);
  if (reviewCount > 0 && reviewCount < (settings.minReview ?? 200)) {
    warnings.push(`レビュー${reviewCount}件（基準${settings.minReview}件未満）`);
  }
  if (reviewAverage > 0 && reviewAverage < (settings.minReviewAverage ?? 4.3)) {
    warnings.push(`評価${reviewAverage}（基準${settings.minReviewAverage}未満）`);
  }
  if (reviewCount === 0 && reviewAverage === 0) {
    warnings.push('レビュー情報が未入力のため「評価が高い」を判定できません');
  }

  const item = {
    itemCode: input.itemCode,
    source: 'manual',
    /** API取得分と区別する。**手入力分は選定ロジックの検証には使わない**（5.4） */
    dataSource: 'manual-input',
    rank: null,
    prevRank: null,
    rankChange: null,
    isNew: false,
    itemName: String(input.itemName ?? '').trim(),
    itemCaptionShort: '',
    catchcopy: '',
    itemPrice: price,
    hasPriceRange: false,
    itemPriceMin: price,
    itemPriceMax: price,
    priceMismatch: false,
    shopName: String(input.shopName ?? '').trim(),
    shopCode: input.shopCode ?? '',
    reviewCount,
    reviewAverage,
    prevReviewCount: null,
    reviewCountChange: null,
    affiliateRate: 0,
    isRateBoosted: false,
    postageFlag: 0,
    availability: 1,
    pointRate: 1,
    pointRateStart: null,
    pointRateEnd: null,
    priceStartTime: null,
    priceEndTime: null,
    itemUrl: input.itemUrl,
    imageUrl: null,
    estimatedReward: 0,
    rewardCapApplied: false,
    hotScore: 0,
    dealScore: 0,
    discount: {},
    reviewUrl: null,
    excluded: false,
    excludeReason: null,
    excludeReasons: [],
    newcomerExempt: false,
    genreId: input.genreId ?? '',
    genreName: input.genreName ?? '（手動追加）',
    priceTier: priceTierOf({ itemPrice: price, hasPriceRange: false }),
    matchedCriteria: [],
    criteriaDetail: null,
    /** 通常の抽出条件では除外される理由。除外はしないが、カードに警告として出す（5.3） */
    manualWarnings: warnings,
    addedAt: input.addedAt,
  };
  return item;
}
