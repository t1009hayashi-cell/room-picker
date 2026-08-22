import type {
  CriteriaDetail,
  CriterionName,
  CriterionResult,
  DiscountInfo,
  PriceTier,
  ScoringConfig,
  SupermarketRules,
} from './types.js';

/**
 * 選定基準の判定（追加要件v1.3 3章 / 4章）。
 *
 * **なぜ日次JSONに残すのか。**
 * 除外条件の判定はしていたが、「どの基準で選ばれたか」が出力に残っていなかった。
 * 投稿文を作る側のAI（プロンプトの3基準）が選定理由を本文に反映できるようにするため、
 * 判定結果と根拠を商品ごとに持たせる。
 *
 * **reason の文字列を投稿文にそのまま転記してはいけない。**
 * 「レビュー1,981件」のような数値の転記は既存の禁止事項に反する。
 * あくまでAIが理由を理解するための情報として渡す。
 */

export const CRITERIA: CriterionName[] = ['スーパーにない', '評価が高い', '今だけ安い'];

export interface CriteriaInput {
  itemName: string;
  catchcopy: string;
  itemPrice: number;
  itemPriceMax: number;
  hasPriceRange: boolean;
  reviewCount: number;
  reviewAverage: number;
  discount: DiscountInfo;
  pointRate: number;
  /** 新着ブースト（レビュー平均の条件を免除した商品） */
  newcomerExempt: boolean;
}

const unmatched: CriterionResult = { matched: false, reason: null, confidence: '確定' };

/** 価格帯の判定。価格帯商品は除外判定と同じく最大価格で見る（既存仕様に合わせる） */
export function judgePriceTier(
  item: Pick<CriteriaInput, 'itemPrice' | 'itemPriceMax' | 'hasPriceRange'>,
  scoring: ScoringConfig,
): PriceTier {
  const t = scoring.priceTier;
  const price = item.hasPriceRange ? item.itemPriceMax : item.itemPrice;
  return price >= t.reachMin && price <= t.reachMax ? 'reach' : 'revenue';
}

/**
 * 数量の抽出。「2kg」「50本入」のような表記から単位と数を取り、閾値と比べる。
 * 「10%増量」のような数字は単位が一致しないので拾わない。
 */
function findBulkQuantity(text: string, rules: SupermarketRules): string | null {
  for (const t of rules.quantity.thresholds) {
    // 数字＋単位。単位は長いものから順に並べてあるので、そのまま交替で使う
    const re = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:${t.pattern})`, 'giu');
    for (const m of text.matchAll(re)) {
      const value = Number(m[1]);
      if (Number.isFinite(value) && value >= t.min) return m[0].trim();
    }
  }
  return null;
}

function findKeyword(text: string, words: string[]): string | null {
  for (const word of words) {
    if (word !== '' && text.includes(word)) return word;
  }
  return null;
}

/**
 * 「スーパーにない」の半自動判定（4章）。
 * **完全な自動化は不可能。** スーパーの品揃えデータが存在しないため、
 * 大容量・加工済み・業務用・専門店・冷凍を代理指標として使い、必ず「推定」とする。
 */
export function judgeNotInSupermarket(
  item: Pick<CriteriaInput, 'itemName' | 'catchcopy'>,
  rules: SupermarketRules,
): CriterionResult {
  const text = `${item.itemName} ${item.catchcopy}`;
  const hits: string[] = [];

  const bulk = findBulkQuantity(text, rules);
  if (bulk) hits.push(`${bulk}の大容量`);

  const processed = findKeyword(text, rules.keywords.processed);
  if (processed) hits.push(`${processed}の加工済み`);

  const bulkWord = findKeyword(text, rules.keywords.bulk);
  if (bulkWord) hits.push(bulkWord);

  const specialty = findKeyword(text, rules.keywords.specialty);
  if (specialty) hits.push(specialty);

  const frozen = findKeyword(text, rules.keywords.frozen);
  if (frozen) hits.push(frozen);

  if (hits.length === 0) return unmatched;
  // 推定である以上、誤判定は必ず起きる。UI側で手動 on/off できるようにしてある
  return { matched: true, reason: hits.join('・'), confidence: '推定' };
}

/** 「評価が高い」。レビュー件数は「サクラでない」ことの担保、実質の判定は評価で行う */
export function judgeWellRated(item: CriteriaInput, scoring: ScoringConfig): CriterionResult {
  const f = scoring.filters;
  const fmt = (n: number) => n.toLocaleString('en-US');

  if (item.newcomerExempt) {
    // 順位が上がっている新着はレビューが溜まっていないだけ。評価条件を免除している
    return {
      matched: true,
      reason: `レビュー${fmt(item.reviewCount)}件・順位上昇中（評価条件を免除）`,
      confidence: '確定',
    };
  }
  if (item.reviewCount < f.minReviewCount) return unmatched;
  if (item.reviewAverage < f.minReviewAverage) return unmatched;
  return {
    matched: true,
    reason: `レビュー${fmt(item.reviewCount)}件・評価${item.reviewAverage}`,
    confidence: '確定',
  };
}

/** 「今だけ安い」。割引・クーポン・ポイント倍率・期限のいずれかがあるか */
export function judgeOnSale(item: CriteriaInput, scoring: ScoringConfig): CriterionResult {
  const parts: string[] = [];
  const d = item.discount;

  if (d.discountRate !== null && d.discountRate !== undefined) parts.push(`${d.discountRate}%OFF`);
  if (d.hasCoupon) parts.push('クーポンあり');
  // ポイントは訴求してよい強さ（5倍以上）のときだけ理由に含める。
  // 3〜4倍は候補にはなるが説得力がないため、プロンプト側でも数字を出さない扱い
  if (item.pointRate >= scoring.point.strongMin) parts.push(`ポイント${item.pointRate}倍`);
  // 期限は年を補ってISO化したものを日付だけにして出す（生の文言は表記ゆれが激しい）
  if (d.couponDeadline) parts.push(`${d.couponDeadline.slice(0, 16).replace('T', ' ')}まで`);

  if (parts.length === 0) return unmatched;
  return { matched: true, reason: parts.join('・'), confidence: '確定' };
}

export interface CriteriaOutcome {
  priceTier: PriceTier;
  matchedCriteria: CriterionName[];
  criteriaDetail: CriteriaDetail;
}

/**
 * 3基準をまとめて判定する。
 * 3つすべてを満たす必要はない。1つ以上に明確に当てはまることが条件。
 */
export function judgeCriteria(
  item: CriteriaInput,
  scoring: ScoringConfig,
  rules: SupermarketRules,
): CriteriaOutcome {
  const detail: CriteriaDetail = {
    スーパーにない: judgeNotInSupermarket(item, rules),
    評価が高い: judgeWellRated(item, scoring),
    今だけ安い: judgeOnSale(item, scoring),
  };
  return {
    priceTier: judgePriceTier(item, scoring),
    matchedCriteria: CRITERIA.filter((name) => detail[name].matched),
    criteriaDetail: detail,
  };
}
