import type { RakutenRawItem, RakutenRawResponse } from '../types.js';

/**
 * 楽天ウェブサービスは2026年にインフラを刷新し、エンドポイントと認証方式が変わった。
 * 旧 app.rakuten.co.jp/services/api/... は廃止済みで、applicationId だけでは認証できない。
 *
 * 変更点
 *  - ベースURLが openapi.rakuten.co.jp に移行
 *  - **ランキングと検索でサービスパスが異なる**（ichibaranking / ichibams）
 *  - applicationId に加えて accessKey が必須。欠けると
 *    「accessKey must be present as a query parameter or in the header」で 400 が返る
 */
const RANKING_ENDPOINT = 'https://openapi.rakuten.co.jp/ichibaranking/api/IchibaItem/Ranking/20220601';
const SEARCH_ENDPOINT = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601';
/**
 * ジャンル検索。サービスパスは ichibagt で、ランキング・検索のどちらとも違う。
 * 版は 20260701（公式ドキュメント記載の現行版）。
 * 旧版 20170711 も応答するが 2026-08-17 に廃止予定のため使わない。
 *
 * 認証情報なしで叩くと、生きている経路は 400（applicationId must be present…）、
 * 存在しない経路は 404（Resource not found）を返す。経路の正否はこれで切り分けられる。
 */
const GENRE_ENDPOINT = 'https://openapi.rakuten.co.jp/ichibagt/api/IchibaGenre/Search/20260701';

export interface ClientOptions {
  applicationId: string;
  /** 楽天アプリ管理画面の「アクセスキー」。2026年の新APIでは必須 */
  accessKey: string;
  affiliateId?: string | null;
  /** 仕様書 4.3: リクエスト間に1秒以上のsleepが必須。既定は 1100ms */
  intervalMs?: number;
  /** formatVersion。2 を指定すると Item のネストが外れる（仕様書 4.1） */
  formatVersion?: 1 | 2;
  /**
   * 楽天ウェブサービスのアプリ設定「許可されたウェブサイト」に登録した自サイトのURL。
   * この仕組みはブラウザからの利用を前提としており、サーバー間通信では参照元が付かないため
   * 「specify valid applicationId」で弾かれる。自サイトのための取得であることを明示する。
   */
  siteUrl?: string | null;
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
  private readonly accessKey: string;
  private readonly affiliateId: string | null;
  private readonly intervalMs: number;
  private readonly formatVersion: 1 | 2;
  private readonly siteUrl: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly onLog: (message: string) => void;
  private lastRequestAt = 0;

  constructor(options: ClientOptions) {
    if (!options.applicationId) {
      throw new Error('applicationId が未設定です（環境変数 RAKUTEN_APPLICATION_ID）');
    }
    if (!options.accessKey) {
      throw new Error(
        'accessKey が未設定です（環境変数 RAKUTEN_ACCESS_KEY）。2026年の新APIでは applicationId と両方が必須です',
      );
    }
    this.applicationId = options.applicationId;
    this.accessKey = options.accessKey;
    this.affiliateId = options.affiliateId ?? null;
    this.intervalMs = Math.max(1000, options.intervalMs ?? 1100);
    this.formatVersion = options.formatVersion ?? 2;
    this.siteUrl = options.siteUrl?.trim() || null;
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
    url.searchParams.set('accessKey', this.accessKey);
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
    const json = (await this.requestJson(endpoint, params)) as RakutenRawResponse;
    return { items: extractItems(json), title: typeof json.title === 'string' ? json.title : '' };
  }

  /** 商品系とジャンル系でレスポンス構造が違うため、JSONのまま返す層を分けている */
  private async requestJson(endpoint: string, params: Record<string, string | number | undefined>): Promise<unknown> {
    await this.throttle();
    const url = this.buildUrl(endpoint, params);
    // アプリIDをログに残さない
    this.onLog(`GET ${endpoint} ${JSON.stringify(params)}`);

    const headers: Record<string, string> = { 'User-Agent': 'room-assist/1.0' };
    if (this.siteUrl) {
      // 「許可されたウェブサイト」に登録した自サイトのための取得であることを明示する
      headers.Referer = this.siteUrl;
      try {
        headers.Origin = new URL(this.siteUrl).origin;
      } catch {
        // URLとして壊れている場合は Origin を付けない
      }
    }

    const res = await this.fetchImpl(url, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const detail = body
        .slice(0, 200)
        .replaceAll(this.applicationId, '***')
        .replaceAll(this.accessKey, '***');
      const hint =
        res.status === 400 && /applicationId|accessKey/i.test(body)
          ? '\nヒント: 楽天アプリ管理画面の「アプリケーションID」を RAKUTEN_APPLICATION_ID に、' +
            '「アクセスキー」を RAKUTEN_ACCESS_KEY に設定してください（2026年の新APIでは両方必須）'
          : '';
      throw new Error(`楽天API エラー: ${res.status} ${res.statusText} ${detail}${hint}`);
    }
    return await res.json();
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

  /**
   * ジャンル検索API。genreId=0 を渡すとジャンルツリーの最上位から辿れる。
   * 設定画面でジャンルを名前で選べるようにするためのマスタ取得に使う。
   */
  async fetchGenre(genreId: string | number): Promise<GenreSearchResult> {
    return parseGenreResponse(await this.requestJson(GENRE_ENDPOINT, { genreId }));
  }
}

/** ジャンルツリーの1ノード */
export interface GenreNode {
  genreId: string;
  genreName: string;
  level: number;
}

export interface GenreSearchResult {
  /** 問い合わせたジャンル自身。genreId=0（ルート）では返らないことがある */
  current: GenreNode | null;
  children: GenreNode[];
}

/**
 * ジャンル検索のレスポンスを GenreNode に均す。
 *
 * 現行版(20260701)は `{ genre, children:[{genreId, nameJa, level}] }`、
 * 旧版は `{ current, children:[{child:{genreId, genreName, genreLevel}}] }` を返す。
 * 版が変わってもここだけ直せば済むよう、両方の形を受ける。
 */
export function parseGenreResponse(json: unknown): GenreSearchResult {
  const root = (json ?? {}) as Record<string, unknown>;
  const rawChildren = root.children ?? root.Children ?? [];
  const children = (Array.isArray(rawChildren) ? rawChildren : [])
    .map((entry) => {
      const obj = entry as Record<string, unknown>;
      // 旧版は要素が { child: {...} } でくるまれている
      return toGenreNode((obj?.child ?? obj?.Child ?? obj) as Record<string, unknown>);
    })
    .filter((node): node is GenreNode => node !== null);

  return { current: toGenreNode((root.genre ?? root.current) as Record<string, unknown>), children };
}

function toGenreNode(raw: Record<string, unknown> | undefined | null): GenreNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const genreId = raw.genreId ?? raw.genreid;
  // 現行版は nameJa、旧版は genreName
  const genreName = raw.nameJa ?? raw.genreName;
  if (genreId === undefined || genreId === null || genreName === undefined || genreName === null) return null;

  const level = Number(raw.level ?? raw.genreLevel);
  return {
    genreId: String(genreId),
    genreName: String(genreName),
    level: Number.isFinite(level) ? level : 0,
  };
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
