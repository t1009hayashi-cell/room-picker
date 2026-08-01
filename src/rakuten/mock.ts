import type { GenreConfig, RakutenRawItem, RakutenRawResponse } from '../types.js';
import { JST_OFFSET_MS } from '../util/datetime.js';
import type { FetchResult } from './client.js';

/**
 * モックデータ生成。
 *
 * 仕様書 4.1 に「実レスポンスで確認済み」として記載された性質を、そのまま再現する。
 *  - 価格・料率・レビュー平均は文字列で返る
 *  - 配列は rank の降順（30位が先頭、1位が末尾）
 *  - itemUrl / shopUrl の末尾に ?rafcid=wsc_i_ra_<アプリID> が付く
 *  - endTime が当日中に切れる商品が上位に混ざる
 *  - 複数ショップが同一のポイント期間を持つ（＝セール）
 *  - 同一ショップだけが 9999-12-31 23:59 の恒常設定を持つ（＝セールではない）
 */

const MOCK_APP_ID = 'mock-application-id-0000';

/** 決定的な擬似乱数（mulberry32）。同じ入力からは常に同じモックが得られる */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function jstStamp(date: Date): string {
  const s = new Date(date.getTime() + JST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${s.getUTCFullYear()}-${p(s.getUTCMonth() + 1)}-${p(s.getUTCDate())} ${p(s.getUTCHours())}:${p(s.getUTCMinutes())}`;
}

const SHOP_POOL = [
  { code: 'gourmetcoffee', name: 'グルメコーヒー豆専門！加藤珈琲店' },
  { code: 'sawaicoffee', name: '澤井珈琲' },
  { code: 'rakuten24', name: '楽天24' },
  { code: 'soukai', name: '爽快ドラッグ' },
  { code: 'kenkocom', name: 'ケンコーコム' },
  { code: 'lohaco', name: 'ロハコ' },
  { code: 'tsukiji-ichiba', name: '築地の王様' },
];

const NAME_PARTS: Record<string, string[]> = {
  '100227': ['送料無料 国産 パスタ 3kg セット', '訳あり 冷凍食品 詰め合わせ 20食', '北海道産 お米 10kg 令和6年産', '万能 だし パック 100包 業務用'],
  '551167': ['スイーツ 福袋 チョコレート 1kg 大容量', 'クッキー 詰め合わせ 40枚 個包装', 'アイス 12個 セット 送料無料', 'ドライフルーツ ミックス 1kg'],
  '100316': ['ラベルレス ミネラルウォーター 500ml×24本', '炭酸水 強炭酸 500ml×48本 まとめ買い', '麦茶 2L×12本 ケース', 'スポーツドリンク 粉末 50袋'],
  '100356': ['送料無料 コーヒー豆 2kg 怒涛の珈琲豆 粉', 'ドリップバッグ コーヒー 100袋 業務用', 'インスタントコーヒー 詰め替え 3個セット', 'カフェオレベース 6本 まとめ買い'],
  '100533': ['おむつ テープ Mサイズ 2パック', 'おしりふき 80枚×20個 まとめ買い', '粉ミルク 800g 2缶セット', 'ベビーフード 12食 詰め合わせ'],
  '558944': ['フライパン 26cm IH対応 セット', '保存容器 10個セット 電子レンジ対応', 'タンブラー 真空断熱 2個', '包丁 三徳 ステンレス'],
  '215783': ['トイレットペーパー 12ロール×8パック', '洗剤 詰め替え 大容量 4個セット', 'ティッシュ 5箱×12パック', 'ゴミ袋 45L 100枚 業務用'],
};

const CAPTION_SEED =
  'こちらの商品は当店人気の定番アイテムです。内容量・原材料・保存方法については商品ページの表記をご確認ください。';

function buildCaption(times: number): string {
  return CAPTION_SEED.repeat(times);
}

export interface MockOptions {
  now?: Date;
  applicationId?: string;
}

/**
 * ランキングAPIのモックレスポンスを1ジャンル分（30件）生成する。
 * 実レスポンスに合わせ、配列は rank の降順で返す。
 */
export function buildMockRanking(genre: GenreConfig, options: MockOptions = {}): RakutenRawResponse {
  const now = options.now ?? new Date();
  const appId = options.applicationId ?? MOCK_APP_ID;
  // 日付をシードに混ぜて、日ごとに順位が入れ替わるようにする（前日比・hotScore の確認用）
  const rand = makeRandom(hashString(`${genre.genreId}:ranking:${jstStamp(now).slice(0, 10)}`));
  const names = NAME_PARTS[genre.genreId] ?? ['まとめ買い セット 大容量'];

  // 複数ショップが共有するセール期間（＝自動検出されるべき期間）
  const saleStart = jstStamp(new Date(now.getTime() + 3 * 86400000));
  const saleEnd = jstStamp(new Date(now.getTime() + 10 * 86400000));
  // 単一ショップの恒常設定（＝セールとして検出してはいけない）
  const foreverEnd = '9999-12-31 23:59';

  const items: RakutenRawItem[] = [];
  for (let rank = 1; rank <= 30; rank += 1) {
    const shop = SHOP_POOL[Math.floor(rand() * SHOP_POOL.length)]!;
    const baseName = names[Math.floor(rand() * names.length)]!;
    const price = Math.round((1200 + rand() * 26000) / 10) * 10;
    const hasRange = rank % 9 === 0;
    const boosted = rank % 11 === 0;
    const inSale = rank % 3 === 0;
    // 単一ショップの恒常ポイント設定（誤検出テスト用）
    const forever = shop.code === 'sawaicoffee' && rank % 2 === 0;

    const item: RakutenRawItem = {
      itemCode: `${shop.code}:${1000000 + Number(genre.genreId) % 1000 * 100 + rank}`,
      itemName: `${baseName}${rank % 7 === 0 ? ' 最安値挑戦中' : ''}${rank % 13 === 0 ? ' 定期購入' : ''}`,
      shopName: shop.name,
      shopCode: shop.code,
      itemPrice: String(price),
      // rank%12: 価格帯でないのに itemPrice と min/max が食い違う商品（実データに存在。仕様書 6.1）
      itemPriceMin1: hasRange ? String(Math.round(price * 0.5)) : rank % 12 === 0 ? String(Math.round(price * 1.18)) : '0',
      itemPriceMax1: hasRange ? String(Math.round(price * 1.8)) : rank % 12 === 0 ? String(Math.round(price * 1.18)) : '0',
      hasPriceRange: hasRange ? 1 : 0,
      itemCaption: buildCaption(rank % 5 === 0 ? 30 : 8),
      catchcopy: 'ショップ独自の宣伝文（投稿文に転記しないこと）',
      reviewCount: Math.floor(rand() * 45000),
      reviewAverage: (3.5 + rand() * 1.5).toFixed(2),
      affiliateRate: boosted ? '6.0' : rank % 5 === 0 ? '' : String(genre.commissionRate * 100),
      postageFlag: rank % 4 === 0 ? 1 : 0,
      availability: rank % 17 === 0 ? 0 : 1,
      pointRate: inSale ? (rank % 6 === 0 ? 20 : 10) : 1,
      pointRateStartTime: forever ? '2025-10-28 14:00' : inSale ? saleStart : '',
      pointRateEndTime: forever ? foreverEnd : inSale ? saleEnd : '',
      startTime: '',
      // 上位に「当日中に価格が切れる商品」を混ぜる（仕様書 6.1 の実測どおり）
      endTime: rank % 8 === 0 ? jstStamp(new Date(now.getTime() + 6 * 3600000)) : '',
      shopOfTheYearFlag: rank % 10 === 0 ? 1 : 0,
      rank,
      genreId: genre.genreId,
      itemUrl: `https://item.rakuten.co.jp/${shop.code}/item-${rank}/?rafcid=wsc_i_ra_${appId}`,
      shopUrl: `https://www.rakuten.co.jp/${shop.code}/?rafcid=wsc_i_ra_${appId}`,
      affiliateUrl: '',
      shopAffiliateUrl: '',
      mediumImageUrls: [{ imageUrl: `https://thumbnail.image.rakuten.co.jp/@0_mall/${shop.code}/${rank}.jpg?_ex=128x128` }],
      smallImageUrls: [{ imageUrl: `https://thumbnail.image.rakuten.co.jp/@0_mall/${shop.code}/${rank}.jpg?_ex=64x64` }],
    };
    items.push(item);
  }

  // 実レスポンスは rank の降順（30位が先頭、1位が末尾）で返る
  items.reverse();

  return {
    title: `ランキング市場【${genre.genreName}】`,
    count: items.length,
    page: 1,
    Items: items,
  };
}

/** 検索APIのモック。順位を持たない点がランキングとの違い */
export function buildMockSearch(genre: GenreConfig, options: MockOptions = {}): RakutenRawResponse {
  const ranking = buildMockRanking(genre, options);
  const items = (ranking.Items as RakutenRawItem[]).slice(0, 10).map((item, i) => ({
    ...item,
    itemCode: `${item.itemCode}-s${i}`,
    rank: undefined,
    postageFlag: 0,
    availability: 1,
  }));
  return { title: `検索結果【${genre.genreName}】`, count: items.length, page: 1, Items: items };
}

export function mockFetchResult(response: RakutenRawResponse): FetchResult {
  return { items: (response.Items ?? []) as RakutenRawItem[], title: response.title ?? '' };
}
