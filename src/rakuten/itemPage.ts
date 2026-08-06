/**
 * レビューURLの組み立て（追加要件 6章）。
 *
 * 商品ページはEUC-JPでレビュー本文が文字化けするが、レビュー専用ページはUTF-8で読める。
 * そのURLを組み立てるには `shopBid`（ショップの数値ID）が必要で、
 * **これはAPIレスポンスに含まれない。** 商品ページのHTMLに
 * `shop_bid=249917&iid=10001714` の形で入っているため、そこから正規表現で取る。
 * 文字化けしていてもこの部分はASCIIなので読み取れる。
 *
 * 全商品で取ると1商品1リクエストになるため、**除外条件を通過した商品のみ**を対象とし、
 * 1秒以上の間隔を空ける。取得に失敗しても null を返してエラーで止めない。
 */

export interface ReviewIds {
  shopBid: string;
  itemNumericId: string;
}

/** HTMLから shop_bid と iid を取り出す。どちらか欠けたら null */
export function extractReviewIds(html: string): ReviewIds | null {
  const shopBid = /shop_bid=(\d+)/.exec(html)?.[1] ?? null;
  const itemNumericId = /[?&]iid=(\d+)/.exec(html)?.[1] ?? null;
  if (shopBid === null || itemNumericId === null) return null;
  return { shopBid, itemNumericId };
}

export function buildReviewUrl(ids: ReviewIds): string {
  return `https://review.rakuten.co.jp/item/1/${ids.shopBid}_${ids.itemNumericId}/1.1/`;
}

export interface ReviewLookupOptions {
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  onLog?: (message: string) => void;
  onWarn?: (message: string) => void;
  /** 1回のバッチで取りに行く上限。増えすぎると日次実行が長くなる */
  maxItems?: number;
}

export interface ReviewLookupResult {
  shopBid: string | null;
  itemNumericId: string | null;
  reviewUrl: string | null;
}

const EMPTY: ReviewLookupResult = { shopBid: null, itemNumericId: null, reviewUrl: null };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 商品ページを順番に取得して shopBid / reviewUrl を埋める。
 * リクエストは必ず直列で、間に1秒以上の間隔を空ける。
 */
export class ReviewUrlResolver {
  private readonly intervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onLog: (message: string) => void;
  private readonly onWarn: (message: string) => void;
  private readonly maxItems: number;
  private lastRequestAt = 0;
  private fetched = 0;
  private failed = 0;

  constructor(options: ReviewLookupOptions = {}) {
    this.intervalMs = Math.max(1000, options.intervalMs ?? 1100);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onLog = options.onLog ?? (() => {});
    this.onWarn = options.onWarn ?? (() => {});
    this.maxItems = options.maxItems ?? 400;
  }

  get stats(): { fetched: number; failed: number } {
    return { fetched: this.fetched, failed: this.failed };
  }

  async resolve(itemUrl: string): Promise<ReviewLookupResult> {
    if (!itemUrl || !/^https?:\/\//.test(itemUrl)) return EMPTY;
    if (this.fetched >= this.maxItems) return EMPTY;

    const wait = this.lastRequestAt + this.intervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
    this.fetched += 1;

    try {
      const res = await this.fetchImpl(itemUrl, {
        headers: { 'User-Agent': 'room-assist/1.0' },
        redirect: 'follow',
      });
      if (!res.ok) {
        this.failed += 1;
        this.onWarn(`${itemUrl} の取得に失敗しました (${res.status})`);
        return EMPTY;
      }
      // EUC-JPで文字化けしても shop_bid / iid はASCIIなので読める
      const html = await res.text();
      const ids = extractReviewIds(html);
      if (ids === null) {
        this.failed += 1;
        this.onWarn(`${itemUrl} に shop_bid が見つかりませんでした`);
        return EMPTY;
      }
      return { shopBid: ids.shopBid, itemNumericId: ids.itemNumericId, reviewUrl: buildReviewUrl(ids) };
    } catch (err) {
      this.failed += 1;
      this.onWarn(`${itemUrl} の取得で例外が発生しました: ${(err as Error).message}`);
      return EMPTY;
    }
  }
}
