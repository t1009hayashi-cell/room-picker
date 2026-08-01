/**
 * 仕様書 4.1 / 5.1 に対応する型定義。
 *
 * 楽天APIは価格・料率・レビュー平均を「文字列」で返し、レビュー件数・在庫・ポイント倍率を
 * 「数値」で返す。formatVersion によっても形が変わるため、生レスポンス側の型は
 * すべて `string | number` を許容し、normalize.ts で明示的にパースする。
 */

export type RawImageUrl = { imageUrl: string } | string;

export interface RakutenRawItem {
  itemCode?: string;
  itemName?: string;
  shopName?: string;
  shopCode?: string;

  itemPrice?: string | number;
  itemPriceMin1?: string | number;
  itemPriceMin2?: string | number;
  itemPriceMin3?: string | number;
  itemPriceMax1?: string | number;
  itemPriceMax2?: string | number;
  itemPriceMax3?: string | number;
  hasPriceRange?: string | number;

  itemCaption?: string;
  catchcopy?: string;

  reviewCount?: string | number;
  reviewAverage?: string | number;

  affiliateRate?: string | number;
  postageFlag?: string | number;
  availability?: string | number;

  pointRate?: string | number;
  pointRateStartTime?: string;
  pointRateEndTime?: string;

  startTime?: string;
  endTime?: string;

  shopOfTheYearFlag?: string | number;
  rank?: string | number;
  genreId?: string | number;

  itemUrl?: string;
  shopUrl?: string;
  affiliateUrl?: string;
  shopAffiliateUrl?: string;

  mediumImageUrls?: RawImageUrl[];
  smallImageUrls?: RawImageUrl[];
}

/** ランキングAPI / 検索API のレスポンス外形（formatVersion 1 / 2 の両方を吸収する前の形） */
export interface RakutenRawResponse {
  title?: string;
  count?: number;
  page?: number;
  Items?: Array<{ Item: RakutenRawItem } | RakutenRawItem>;
  items?: RakutenRawItem[];
}

export type ItemSource = 'ranking' | 'search';

export type ExcludeReasonCode =
  | 'price_below_min'
  | 'review_below_min'
  | 'out_of_stock'
  | 'shipping_fee_separate'
  | 'subscription_word'
  | 'health_word'
  | 'price_expired';

/** 閾値の変更で復活しうる除外理由。UI 側の再評価対象（仕様書 6.1「設定で閾値変更可」） */
export const THRESHOLD_REASONS: readonly ExcludeReasonCode[] = [
  'price_below_min',
  'review_below_min',
  'shipping_fee_separate',
];

export interface DraftComment {
  angle: string;
  text: string;
  firstLine: string;
  firstLineLength: number;
  hashtags: string[];
}

/** 仕様書 5.1 の正規化済み商品。日次JSONにこの形で保存する */
export interface NormalizedItem {
  itemCode: string;
  source: ItemSource;

  rank: number | null;
  prevRank: number | null;
  rankChange: number | null;
  isNew: boolean;

  itemName: string;
  itemCaptionShort: string;
  catchcopy: string;

  itemPrice: number;
  hasPriceRange: boolean;
  itemPriceMin: number;
  itemPriceMax: number;
  /** itemPrice と itemPriceMin/Max が食い違う場合に立てる（仕様書 6.1）。UIで注意表示する */
  priceMismatch: boolean;

  shopName: string;
  shopCode: string;

  reviewCount: number;
  reviewAverage: number;

  affiliateRate: number;
  affiliateRateSource: 'api' | 'genre-fallback';
  isRateBoosted: boolean;

  postageFlag: number;
  availability: number;

  pointRate: number;
  pointRateStart: string | null;
  pointRateEnd: string | null;
  priceStartTime: string | null;
  priceEndTime: string | null;

  shopOfTheYearFlag: number;
  itemGenreId: string;

  itemUrl: string;
  shopUrl: string;
  imageUrl: string | null;

  estimatedReward: number;
  /** 報酬上限1,000円が適用されたか。UIで区別表示する（仕様書 8.2） */
  rewardCapApplied: boolean;

  hotScore: number;

  excluded: boolean;
  excludeReason: string | null;
  excludeReasons: ExcludeReasonCode[];

  draftComments: DraftComment[];
}

export interface GenreSnapshot {
  genreId: string;
  genreName: string;
  commissionRate: number;
  /** レスポンスの title 検査（仕様書 4.1.1）で不一致だった場合の警告 */
  warnings: string[];
  items: NormalizedItem[];
}

export interface DailySnapshot {
  fetchedAt: string;
  date: string;
  generatedBy: 'live' | 'mock';
  genres: GenreSnapshot[];
}

export interface SaleEntry {
  id: string;
  name: string;
  start: string;
  end: string;
  itemCount: number;
  source: 'auto' | 'manual';
  userLabel: string | null;
}

export interface SalesFile {
  updatedAt: string;
  sales: SaleEntry[];
}

export interface IndexFile {
  updatedAt: string;
  dates: string[];
  latest: string | null;
}

export interface GenreConfig {
  genreId: string;
  genreName: string;
  commissionRate: number;
  enabled: boolean;
}

export interface NgWordsConfig {
  subscription: string[];
  health: string[];
  commentBanned: string[];
  searchNgKeyword: string;
}

export interface ScoringConfig {
  filters: {
    minPrice: number;
    minReviewCount: number;
    excludeOutOfStock: boolean;
    excludeShippingFeeSeparate: boolean;
  };
  reward: {
    rewardCapPerItem: number;
    roomRankBonusRate: number;
    roomRankBonusCap: number;
    rateBoostThreshold: number;
  };
  hotScore: {
    rankGainPerRank: number;
    newEntryBonus: number;
    reviewDivisor: number;
    reviewCap: number;
    priceSweetSpotMin: number;
    priceSweetSpotMax: number;
    priceSweetSpotBonus: number;
    rateBoostedBonus: number;
    pointRateCap: number;
  };
  sales: {
    minDistinctShops: number;
    maxDurationDays: number;
    infiniteEndMarker: string;
  };
  comment: {
    firstLineMin: number;
    firstLineMax: number;
    totalMin: number;
    totalMax: number;
    maxLines: number;
    hashtagMin: number;
    hashtagMax: number;
  };
  caption: { shortLength: number };
  analytics: { minSampleSize: number };
}
