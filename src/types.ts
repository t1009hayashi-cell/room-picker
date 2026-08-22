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

/** 'manual' は候補一覧に出てこない商品をユーザーが手で足したもの（追加要件v1.3 5章） */
export type ItemSource = 'ranking' | 'search' | 'manual';

/** 価格帯（追加要件v1.3 2章）。reach=リーチ枠（1,000〜3,000円）/ revenue=収益枠 */
export type PriceTier = 'reach' | 'revenue';

export type CriterionName = 'スーパーにない' | '評価が高い' | '今だけ安い';

/**
 * 判定の確からしさ。
 * 確定=API値による判定 / 推定=商品名からの推定（スーパー判定） / 手動=ユーザーが上書きした
 */
export type CriterionConfidence = '確定' | '推定' | '手動';

export interface CriterionResult {
  matched: boolean;
  /** AIが理由を理解するための文字列。**投稿文にそのまま転記しないこと** */
  reason: string | null;
  confidence: CriterionConfidence;
}

export type CriteriaDetail = Record<CriterionName, CriterionResult>;

/** 「スーパーにない」の代理指標（追加要件v1.3 4章）。運用しながら調整するため外出しする */
export interface SupermarketRules {
  quantity: {
    thresholds: { unit: string; pattern: string; min: number }[];
  };
  keywords: {
    processed: string[];
    bulk: string[];
    specialty: string[];
    frozen: string[];
  };
}

export type ExcludeReasonCode =
  | 'price_below_min'
  | 'review_below_min'
  | 'review_average_below_min'
  | 'out_of_stock'
  | 'shipping_fee_separate'
  | 'subscription_word'
  | 'health_word'
  | 'price_expired';

/** 閾値の変更で復活しうる除外理由。UI 側の再評価対象（仕様書 6.1「設定で閾値変更可」） */
export const THRESHOLD_REASONS: readonly ExcludeReasonCode[] = [
  'price_below_min',
  'review_below_min',
  'review_average_below_min',
  'shipping_fee_separate',
];

/**
 * ポイント倍率の扱い（追加要件 3章）。
 * 「候補に入れる」と「訴求してよい」を分ける。
 *  - `strong` … 投稿文で倍率を出してよい
 *  - `weak`   … 候補には入れるが投稿文で数字を出さない
 *  - `null`   … 加点も訴求もしない（恒常設定を含む）
 */
export type PointBoost = 'weak' | 'strong' | null;

/**
 * クーポン・割引の抽出結果（追加要件 2章）。
 * 楽天にクーポン専用APIは無く、店舗が itemName / catchcopy に書き込んだ文言から取る。
 * **抽出した文言そのものは投稿文に転記しない。** 数値としてのみ持つ（景表法上の表示責任を負うため）。
 */
export interface DiscountInfo {
  /** 割引率（%）。期限切れの場合は null に戻す */
  discountRate: number | null;
  hasCoupon: boolean;
  /** 抽出元の文言そのまま。UIの確認用で、投稿文には使わない */
  couponDeadlineRaw: string | null;
  /** 年を補って ISO(+09:00) にしたもの */
  couponDeadline: string | null;
  priceBefore: number | null;
  priceAfter: number | null;
  extractedFrom: 'itemName' | 'catchcopy' | null;
  /** 期限が過去だった場合に立てる。UIに「割引終了」と出す */
  discountExpired: boolean;
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
  /** 前日のレビュー件数と増加数。前日データが無ければ null（0件増と区別する） */
  prevReviewCount: number | null;
  reviewCountChange: number | null;

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
  /** 「今だけ安い」の強さ（追加要件 4章）。一覧は hotScore + dealScore の降順で並べる */
  dealScore: number;

  /** ポイント倍率の扱い（追加要件 3章） */
  pointBoost: PointBoost;

  /** クーポン・割引の抽出結果（追加要件 2章） */
  discount: DiscountInfo;

  /** ショップの数値ID。APIには含まれず、商品ページのHTMLから取る（追加要件 6章） */
  shopBid: string | null;
  itemNumericId: string | null;
  /** レビュー専用ページ。商品ページと違いUTF-8で読める。取得失敗時は null */
  reviewUrl: string | null;

  excluded: boolean;
  excludeReason: string | null;
  excludeReasons: ExcludeReasonCode[];
  /**
   * レビュー平均の条件を免除した商品（追加要件 1.2）。
   * 注目され始めてレビューが溜まっていないだけなので、定番より投稿の希少価値が高い。
   */
  newcomerExempt: boolean;

  /** 価格帯（追加要件v1.3 2章）。一覧の配分をここで決める */
  priceTier: PriceTier;
  /** 当てはまった選定基準。空の商品は候補に出さない（3.2） */
  matchedCriteria: CriterionName[];
  /** 判定の根拠。投稿文にそのまま転記しないこと */
  criteriaDetail: CriteriaDetail;
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
    /** レビュー平均の下限（追加要件 1章）。実質の品質判定はこちらで行う */
    minReviewAverage: number;
    excludeOutOfStock: boolean;
    excludeShippingFeeSeparate: boolean;
    /** 新着ブースト（追加要件 1.2）。この条件を満たすとレビュー平均の条件を免除する */
    newcomer: {
      minReviewCount: number;
      minRankChange: number;
    };
  };
  point: {
    weakMin: number;
    strongMin: number;
  };
  dealScore: {
    discountRateThreshold: number;
    discountBonus: number;
    couponBonus: number;
    pointStrongBonus: number;
    pointWeakBonus: number;
    duringSaleBonus: number;
  };
  reward: {
    rewardCapPerItem: number;
    roomRankBonusRate: number;
    roomRankBonusCap: number;
    rateBoostThreshold: number;
  };
  /** 価格帯の境目と出力比率（追加要件v1.3 2章） */
  priceTier: {
    reachMin: number;
    reachMax: number;
    /** 出力に占めるリーチ枠の割合。運用方針が変わったときコードを触らず調整するための設定値 */
    reachRatio: number;
  };
  hotScore: {
    rankGainPerRank: number;
    newEntryBonus: number;
    reviewDivisor: number;
    reviewCap: number;
    /** リーチ枠（1,000〜3,000円）の加点。旧実装ではここが加点対象外だった */
    reachPriceBonus: number;
    revenuePriceMax: number;
    revenuePriceBonus: number;
    rateBoostedBonus: number;
    pointRateCap: number;
  };
  sales: {
    minDistinctShops: number;
    maxDurationDays: number;
    infiniteEndMarker: string;
  };
  caption: { shortLength: number };
  analytics: { minSampleSize: number };
}
