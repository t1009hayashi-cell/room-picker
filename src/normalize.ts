import type { GenreConfig, ItemSource, NormalizedItem, RakutenRawItem, ScoringConfig } from './types.js';
import { parseRakutenDateTime } from './util/datetime.js';
import { parseAffiliateRate, toBooleanFlag, toNumber, toNumberOrNull, toStringSafe } from './util/parse.js';
import { pickImageUrl, sanitizeUrl } from './util/url.js';

/** 正規化のうち、前日比・報酬・スコア・除外・投稿文を除いた部分 */
export type NormalizedBase = Omit<
  NormalizedItem,
  | 'prevRank'
  | 'rankChange'
  | 'isNew'
  | 'estimatedReward'
  | 'rewardCapApplied'
  | 'hotScore'
  | 'excluded'
  | 'excludeReason'
  | 'excludeReasons'
  | 'draftComments'
>;

export interface NormalizeContext {
  source: ItemSource;
  genre: GenreConfig;
  scoring: ScoringConfig;
  /** URL から除去するアプリID（rafcid の値に含まれる） */
  applicationId?: string | null;
}

/** 文字数で切り詰める。サロゲートペアを壊さないよう Array.from で分割する */
export function truncate(text: string, length: number): string {
  const chars = Array.from(text);
  return chars.length <= length ? text : chars.slice(0, length).join('');
}

function collectPrices(raw: RakutenRawItem, keys: (keyof RakutenRawItem)[]): number[] {
  const out: number[] = [];
  for (const key of keys) {
    const n = toNumberOrNull(raw[key]);
    if (n !== null && n > 0) out.push(n);
  }
  return out;
}

/**
 * 仕様書 5.1「保存前の正規化ルール（必須）」を適用する。
 * APIのレスポンスをそのまま保存しない。型・単位・URL・日時をすべてここで揃える。
 */
export function normalizeItem(raw: RakutenRawItem, ctx: NormalizeContext): NormalizedBase | null {
  const itemCode = toStringSafe(raw.itemCode).trim();
  if (itemCode === '') return null; // itemCode は主キー。無い行は保存しない

  const appId = ctx.applicationId ?? null;

  const itemPrice = toNumber(raw.itemPrice, 0);
  const hasPriceRange = toBooleanFlag(raw.hasPriceRange);
  const mins = collectPrices(raw, ['itemPriceMin1', 'itemPriceMin2', 'itemPriceMin3']);
  const maxs = collectPrices(raw, ['itemPriceMax1', 'itemPriceMax2', 'itemPriceMax3']);
  const itemPriceMin = mins.length > 0 ? Math.min(...mins) : itemPrice;
  const itemPriceMax = maxs.length > 0 ? Math.max(...maxs) : itemPrice;

  const apiRate = parseAffiliateRate(raw.affiliateRate);
  const affiliateRate = apiRate ?? ctx.genre.commissionRate;
  const threshold = ctx.scoring.reward.rateBoostThreshold;

  return {
    itemCode,
    source: ctx.source,

    rank: toNumberOrNull(raw.rank),

    itemName: toStringSafe(raw.itemName),
    itemCaptionShort: truncate(toStringSafe(raw.itemCaption), ctx.scoring.caption.shortLength),
    catchcopy: toStringSafe(raw.catchcopy),

    itemPrice,
    hasPriceRange,
    itemPriceMin,
    itemPriceMax,
    // itemPrice が価格帯の外に出ている商品が実在する（仕様書 6.1）。UIで注意表示するためのフラグ
    priceMismatch: itemPrice < itemPriceMin || itemPrice > itemPriceMax,

    shopName: toStringSafe(raw.shopName),
    shopCode: toStringSafe(raw.shopCode),

    reviewCount: toNumber(raw.reviewCount, 0),
    reviewAverage: toNumber(raw.reviewAverage, 0),

    affiliateRate,
    affiliateRateSource: apiRate !== null ? 'api' : 'genre-fallback',
    // 浮動小数の丸め差で 5% ちょうどの商品を取りこぼさないよう極小のイプシロンを引く
    isRateBoosted: affiliateRate >= threshold - 1e-9,

    postageFlag: toNumber(raw.postageFlag, 1),
    availability: toNumber(raw.availability, 0),

    pointRate: toNumber(raw.pointRate, 1),
    pointRateStart: parseRakutenDateTime(raw.pointRateStartTime),
    pointRateEnd: parseRakutenDateTime(raw.pointRateEndTime),
    priceStartTime: parseRakutenDateTime(raw.startTime),
    priceEndTime: parseRakutenDateTime(raw.endTime),

    shopOfTheYearFlag: toNumber(raw.shopOfTheYearFlag, 0),
    itemGenreId: toStringSafe(raw.genreId),

    itemUrl: sanitizeUrl(raw.itemUrl, appId),
    shopUrl: sanitizeUrl(raw.shopUrl, appId),
    imageUrl: pickImageUrl(raw.mediumImageUrls ?? raw.smallImageUrls, appId),
  };
}

/**
 * 仕様書 4.1「配列の順序を順位とみなさず、必ず rank でソートし直すこと」。
 * 実レスポンスは 30位が先頭・1位が末尾という降順で返る。
 * rank を持たない検索API由来はランキング勢の後ろに回す。
 */
export function sortByRank<T extends { rank: number | null }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.rank === null && b.rank === null) return 0;
    if (a.rank === null) return 1;
    if (b.rank === null) return -1;
    return a.rank - b.rank;
  });
}

/**
 * ランキングAPIと検索APIの結果を itemCode でマージする（仕様書 4.2）。
 * 同一 itemCode はランキング由来（順位を持つ方）を優先する。
 */
export function mergeByItemCode(rankingItems: NormalizedBase[], searchItems: NormalizedBase[]): NormalizedBase[] {
  const map = new Map<string, NormalizedBase>();
  for (const item of rankingItems) map.set(item.itemCode, item);
  for (const item of searchItems) {
    if (!map.has(item.itemCode)) map.set(item.itemCode, item);
  }
  return sortByRank([...map.values()]);
}
