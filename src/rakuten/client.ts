import type { RakutenRawItem, RakutenRawResponse } from '../types.js';

const RANKING_ENDPOINT = 'https://app.rakuten.co.jp/services/api/IchibaItem/Ranking/20220601';
const SEARCH_ENDPOINT = 'https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601';

export interface ClientOptions {
  applicationId: string;
  affiliateId?: string | null;
  /** 仕様書 4.3: リクエスト間に1秒以上のsleepが必須。既定は 1100ms */
  intervalMs?: number;
  /** formatVersion。2 を指定すると Item のネストが外れる（仕様書 4.1） */
  formatVersion?: 1 | 2;
  fetchImpl?: typeof fetch;
  onLog?: (message: string) => void;
}

export interface FetchResult {
  items: RakutenRawItem[];
  /** レスポンスの title。ジャンル検証に使う（仕様書 4.1.1） */
  title: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 楽天ウェブサービスのクライアント。
 * 仕様書 4.3 に従い、全リクエストを直列で実行し、間に必ず 1 秒以上のsleepを挟む。
 */
export class RakutenClient {
  private readonly applicationId: string;
  private readonly affiliateId: string | null;
  private readonly intervalMs: number;
  private readonly formatVersion: 1 | 2;
  private readonly fetchImpl: typeof fetch;
  private readonly onLog: (message: string) => void;
  private lastRequestAt = 0;

  constructor(options: ClientOptions) {
    if (!options.applicationId) {
      throw new Error('applicationId が未設定です（環境変数 RAKUTEN_APPLICATION_ID）');
    }
    this.applicationId = options.applicationId;
    this.affiliateId = options.affiliateId ?? null;
    this.intervalMs = Math.max(1000, options.intervalMs ?? 1100);
    this.formatVersion = options.formatVersion ?? 2;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onLog = options.onLog ?? (() => {});
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.intervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  private buildUrl(endpoint: string, params: Record<string, string | number | undefined>): string {
    const url = new URL(endpoint);
    url.searchParams.set('applicationId', this.applicationId);
    url.searchParams.set('format', 'json');
    url.searchParams.set('formatVersion', String(this.formatVersion));
    if (this.affiliateId) url.searchParams.set('affiliateId', this.affiliateId);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async request(endpoint: string, params: Record<string, string | number | undefined>): Promise<FetchResult> {
    await this.throttle();
    const url = this.buildUrl(endpoint, params);
    // アプリIDをログに残さない
    this.onLog(`GET ${endpoint} ${JSON.stringify(params)}`);

    const res = await this.fetchImpl(url, { headers: { 'User-Agent': 'room-assist/1.0' } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `楽天API エラー: ${res.status} ${res.statusText} ${body.slice(0, 200).replace(this.applicationId, '***')}`,
      );
    }
    const json = (await res.json()) as RakutenRawResponse;
    return { items: extractItems(json), title: typeof json.title === 'string' ? json.title : '' };
  }

  /** ランキングAPI（仕様書 4.1） */
  fetchRanking(genreId: string, page = 1): Promise<FetchResult> {
    return this.request(RANKING_ENDPOINT, { genreId, page });
  }

  /** 商品検索API（仕様書 4.2）。除外条件は可能な限りAPI側に寄せる */
  fetchSearch(params: {
    genreId: string;
    minPrice?: number;
    maxPrice?: number;
    ngKeyword?: string;
    sort?: string;
    hits?: number;
    page?: number;
  }): Promise<FetchResult> {
    return this.request(SEARCH_ENDPOINT, {
      genreId: params.genreId,
      minPrice: params.minPrice,
      maxPrice: params.maxPrice,
      NGKeyword: params.ngKeyword,
      sort: params.sort ?? '-reviewCount',
      hits: params.hits ?? 30,
      page: params.page ?? 1,
      postageFlag: 1, // 送料込みのみ（仕様書 4.2）
      availability: 1, // 在庫ありのみ
    });
  }
}

/**
 * formatVersion=1 は `Items: [{Item: {...}}]`、formatVersion=2 は `Items: [{...}]` を返す。
 * どちらでも動くよう吸収する（仕様書 4.1「実装時に検証すること」）。
 */
export function extractItems(json: RakutenRawResponse): RakutenRawItem[] {
  const list = json.Items ?? json.items ?? [];
  if (!Array.isArray(list)) return [];
  return list.map((entry) => {
    if (entry && typeof entry === 'object' && 'Item' in entry) {
      return (entry as { Item: RakutenRawItem }).Item ?? {};
    }
    return entry as RakutenRawItem;
  });
}
