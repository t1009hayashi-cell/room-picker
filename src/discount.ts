/**
 * クーポン・割引情報の抽出（追加要件 2章）と、ポイント倍率の扱い（3章）。
 *
 * **楽天ウェブサービスにクーポン専用APIは存在しない。**
 * 提供されているのは市場・ブックス・トラベル・レシピ・Kobo・GORA のみ。
 * ただし店舗が集客のため `itemName` と `catchcopy` に書き込んでいるため、
 * テキストから抽出できる。
 *
 * **抽出した文言そのものは投稿文に転記しない。** 数値としてのみ保持する。
 * 「最安値に挑戦」等が混入すると景表法上の表示責任を負うため。
 */

import type { DiscountInfo, PointBoost, ScoringConfig } from './types.js';

/**
 * 割引率。
 * **`OFF`／`オフ`／`ポイントバック` を必ず伴う場合だけ拾う。**
 * これを外すと「10%増量」「50%配合」のような割引以外の％に反応してしまう（追加要件 9章）。
 * 全角％と半角%の両方が実データに存在する。
 */
const DISCOUNT_RATE = /(\d{1,2})\s*[%％]\s*(?:OFF|off|Off|オフ|ポイントバック)/gu;

/** 「半額」は割引率50%として扱う（追加要件 2.2） */
const HALF_PRICE = /半額/u;

const COUPON = /クーポン/u;

/**
 * 期限。「7/31 23:59まで」「8月3日まで」の形。
 * 年は書かれないため、呼び出し側で「最も近い未来」として補う。
 */
const DEADLINE = /(\d{1,2})\s*[/／月]\s*(\d{1,2})\s*日?\s*(?:\((?:[月火水木金土日])\))?\s*(?:(\d{1,2})\s*[:：]\s*(\d{2}))?\s*まで/u;

/** 「4,620円→2,992円」の形 */
const PRICE_CHANGE = /([\d,]+)\s*円\s*[→⇒]\s*([\d,]+)\s*円/u;

function toNumber(text: string): number | null {
  const n = Number(text.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** その文字列から取れる最大の割引率。複数書かれていれば大きい方を採る */
function maxDiscountRate(text: string): number | null {
  DISCOUNT_RATE.lastIndex = 0;
  let best: number | null = null;
  let match: RegExpExecArray | null;
  while ((match = DISCOUNT_RATE.exec(text)) !== null) {
    const rate = Number(match[1]);
    // 100%OFF は実在しない。桁の読み違いとして捨てる
    if (!Number.isFinite(rate) || rate <= 0 || rate >= 100) continue;
    if (best === null || rate > best) best = rate;
  }
  if (best === null && HALF_PRICE.test(text)) return 50;
  return best;
}

/**
 * 「7/31 23:59まで」を ISO(+09:00) にする。年は書かれていないので補う。
 *
 * **基準日から絶対距離で最も近い年を選ぶ。**
 * 追加要件 2.3 は「最も近い未来の日付として解釈する」と書いているが、それだと
 * 8/4 に「7/31まで」と書かれた**売れ残りの販促文が翌年扱いになり、
 * 4日前に終わった割引を有効なものとして表示してしまう。**
 * 追加要件 2.3 はもう一方で「期限が過去なら discountRate をリセットして
 * 『割引終了』と表示する」とも定めており、未来しか選ばないとこの規則が成立しない。
 * 両方を満たすため、過去も候補に入れて最も近い年を採る。
 *
 * - 8/4 に「7/31まで」 → 今年の 7/31（4日前）。翌年の 7/31 は361日先なので選ばない
 * - 12/20 に「1/5まで」 → 翌年の 1/5（16日先）。今年の 1/5 は349日前なので選ばない（追加要件 9章）
 */
export function resolveDeadline(
  month: number,
  day: number,
  hour: number,
  minute: number,
  now: Date,
): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;

  // JSTの壁時計で考える
  const nowJst = new Date(now.getTime() + 9 * 3600000);
  const baseYear = nowJst.getUTCFullYear();

  let best: { ms: number; distance: number } | null = null;
  for (const year of [baseYear - 1, baseYear, baseYear + 1]) {
    const ms = Date.UTC(year, month - 1, day, hour, minute) - 9 * 3600000;
    // その月に存在しない日付（2/30 など）は捨てる
    const check = new Date(ms + 9 * 3600000);
    if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) continue;

    const distance = Math.abs(ms - now.getTime());
    if (best === null || distance < best.distance) best = { ms, distance };
  }
  return best === null ? null : toIsoJst(best.ms);
}

function toIsoJst(ms: number): string {
  const jst = new Date(ms + 9 * 3600000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())}T${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}:00+09:00`;
}

const EMPTY: DiscountInfo = {
  discountRate: null,
  hasCoupon: false,
  couponDeadlineRaw: null,
  couponDeadline: null,
  priceBefore: null,
  priceAfter: null,
  extractedFrom: null,
  discountExpired: false,
};

/**
 * itemName と catchcopy の両方から抽出する。
 * 項目ごとに、値が取れた方を採る（itemName を優先）。
 * 抽出できなかった項目は null のまま。推測して埋めない。
 */
export function extractDiscount(itemName: string, catchcopy: string, now: Date): DiscountInfo {
  const sources: Array<{ from: 'itemName' | 'catchcopy'; text: string }> = [
    { from: 'itemName', text: String(itemName ?? '') },
    { from: 'catchcopy', text: String(catchcopy ?? '') },
  ];

  const out: DiscountInfo = { ...EMPTY };

  for (const { from, text } of sources) {
    if (text === '') continue;

    if (out.discountRate === null) {
      const rate = maxDiscountRate(text);
      if (rate !== null) {
        out.discountRate = rate;
        out.extractedFrom = from;
      }
    }

    if (!out.hasCoupon && COUPON.test(text)) {
      out.hasCoupon = true;
      out.extractedFrom = out.extractedFrom ?? from;
    }

    if (out.couponDeadlineRaw === null) {
      const m = DEADLINE.exec(text);
      if (m) {
        out.couponDeadlineRaw = m[0].trim();
        out.couponDeadline = resolveDeadline(
          Number(m[1]),
          Number(m[2]),
          m[3] ? Number(m[3]) : 23,
          m[4] ? Number(m[4]) : 59,
          now,
        );
        out.extractedFrom = out.extractedFrom ?? from;
      }
    }

    if (out.priceBefore === null) {
      const m = PRICE_CHANGE.exec(text);
      if (m) {
        const before = toNumber(m[1]!);
        const after = toNumber(m[2]!);
        // 値下げになっていない組み合わせは読み違いとして捨てる
        if (before !== null && after !== null && before > after) {
          out.priceBefore = before;
          out.priceAfter = after;
          out.extractedFrom = out.extractedFrom ?? from;
        }
      }
    }
  }

  // 期限が過去なら割引率をリセットする（追加要件 2.3）。
  // 「割引終了」とUIに出すため、期限そのものは残す
  if (out.couponDeadline !== null) {
    const end = Date.parse(out.couponDeadline);
    if (!Number.isNaN(end) && end < now.getTime()) {
      out.discountExpired = true;
      out.discountRate = null;
    }
  }

  return out;
}

/**
 * ポイント倍率の扱い（追加要件 3章）。
 *
 * `pointRateEnd` が `9999-12-31` の商品は**恒常設定**であり「今だけ」ではないため、
 * 倍率に関係なく null にする。実データで澤井珈琲の pointRate:2 がこの形だった。
 */
export function calcPointBoost(
  pointRate: number,
  pointRateEnd: string | null,
  scoring: ScoringConfig,
): PointBoost {
  if (pointRateEnd !== null && pointRateEnd.startsWith('9999')) return null;
  const p = scoring.point;
  if (pointRate >= p.strongMin) return 'strong';
  if (pointRate >= p.weakMin) return 'weak';
  return null;
}
