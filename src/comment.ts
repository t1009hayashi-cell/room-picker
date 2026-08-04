import type { DraftComment, NgWordsConfig, ScoringConfig } from './types.js';
import { containsAny } from './filter.js';

/**
 * 投稿文の生成。
 *
 * ユーザーが実際にAIへ投げているプロンプト（`新規 テキスト ドキュメント (2).txt`）の型に合わせている。
 * 仕様書 9.1 は「1行目30〜35文字・全体80〜150文字・3行以内」と書いているが、
 * 運用の中でヘッダー約20文字・ボディ120〜180文字に変わった。**プロンプト側を正とする。**
 *
 * 投稿の構造（5要素のうちテキストで扱う4つ）
 *  1. ヘッダー   … 約20文字。フィードではここしか出ない。**数字を必ず1つ入れる**
 *  2. ボディ     … 結論→理由→共感。理由は ✅ の箇条書き2〜3項目
 *  3. 導入部     … 楽天市場へ送り出す一文
 *  4. ハッシュタグ … 3〜6個。感情・行動タグを必ず1つ
 *
 * 守っていること
 *  - 商品名・ブランド名から書き始めない
 *  - **文末を「。」で終わらせない**（言い切り・感想・絵文字で締める）
 *  - 使用体験を装わない。体験談の代わりに生活場面の具体性で補う
 *  - 商品名の「最安値」「楽天1位」等を転記しない
 *  - ページに無い効果・健康効果を書かない
 *  - 他ブランドとの類似を示す表現を書かない（著作権リスク）
 *  - 味・食感など食べないと分からない要素は断定しない
 */

export const ANGLES = ['手間削減', 'ストック切れ回避', '献立負担', 'コスパ比較', '季節', 'セール速報'] as const;
export type Angle = (typeof ANGLES)[number];

export interface CommentInput {
  itemName: string;
  genreName: string;
  itemPrice: number;
  reviewCount: number;
  reviewAverage: number;
  postageFlag: number;
  pointRate: number;
  /** 季節判定に使う JST の月（1-12） */
  month: number;
  /** 期間限定価格の終了日時（ISO）。セール速報の角度と期限の明記に使う */
  priceEndTime?: string | null;
}

/** 商品名から拾うカテゴリ語。長い語を優先して照合する */
const CATEGORY_WORDS: string[] = [
  'インスタントコーヒー',
  'ドリップバッグ',
  'ミネラルウォーター',
  'トイレットペーパー',
  'キッチンペーパー',
  'オリーブオイル',
  'スポーツドリンク',
  'ボディソープ',
  'ハンドソープ',
  'ベビーフード',
  'チョコレート',
  'ドライフルーツ',
  '冷凍食品',
  'レトルト',
  '保存容器',
  'おしりふき',
  '粉ミルク',
  'シャンプー',
  'プロテイン',
  'コーヒー',
  '炭酸水',
  'ジュース',
  'シリアル',
  'クッキー',
  'せんべい',
  'タンブラー',
  'フライパン',
  'ゴミ袋',
  'ティッシュ',
  '柔軟剤',
  'おむつ',
  'サプリ',
  'スイーツ',
  'ラーメン',
  'パスタ',
  'うどん',
  'そば',
  'アイス',
  'ナッツ',
  'グミ',
  '調味料',
  '醤油',
  '味噌',
  'だし',
  'スープ',
  '缶詰',
  '洗剤',
  'ラップ',
  '包丁',
  '水筒',
  '食器',
  '麦茶',
  '緑茶',
  '紅茶',
  'お茶',
  'お米',
  'パン',
  'ケーキ',
  'ゼリー',
  '油',
  '鍋',
  '水',
];

const SEASON_WORDS: Record<Season, string[]> = {
  spring: ['新生活', '入学', '花見', '母の日', '春'],
  summer: ['麦茶', '炭酸水', '冷', 'アイス', 'そうめん', 'スポーツドリンク', 'ゼリー', '夏'],
  autumn: ['栗', 'さつまいも', 'ハロウィン', '秋', '新米'],
  winter: ['ホット', '鍋', '福袋', 'あったか', 'ココア', 'おでん', '冬'],
};

type Season = 'spring' | 'summer' | 'autumn' | 'winter';

const SEASON_LEAD: Record<Season, string> = {
  spring: '新生活の時期',
  summer: '暑い時期',
  autumn: '肌寒くなる時期',
  winter: '寒い時期',
};

/**
 * 季節ごとの生活場面。体験談が書けない分をここで補う（プロンプトの「シーンの具体性」）。
 * 商品カテゴリを問わず使えるよう、特定の商品を前提にした言い方は避ける。
 */
const SEASON_SCENE: Record<Season, string> = {
  spring: '荷物が増える春先',
  summer: '外に出るのが億劫な暑い日',
  autumn: '買い足しを忘れがちな時期',
  winter: '外に出たくない寒い日',
};

const BULK_WORDS = ['まとめ買い', 'ケース', '箱', '大容量', '業務用', '詰め替え', '詰替', 'セット', '×', 'ラベルレス'];
const STOCK_WORDS = ['まとめ買い', 'ケース', '箱', '業務用', '大容量', 'ストック', '常備', '長期保存', '入', 'セット'];
/** 献立負担の角度が効く商品。冷凍・味付け済みなど「そのまま出せる」もの */
const MEAL_WORDS = ['冷凍', '骨取り', '骨なし', 'カット', '味付', '総菜', 'そうざい', 'おかず', 'レンジ', '湯煎', '下処理', '時短'];

/** 数量の単位。1本あたり／1袋あたりの単価算出に使う */
const UNIT_PATTERN = /(\d+(?:\.\d+)?)\s*(本|袋|個|缶|杯|パック|枚|包|食|箱|セット)/g;

export function seasonOf(month: number): Season {
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter';
}

/**
 * 1文字のカテゴリ語が複合語の一部に誤マッチするのを防ぐ。
 * 例: 珪藻土バスマットの「吸水」から「水」を拾って「水の買い出し」という投稿文になった。
 * 語の直前が漢字・ひらがな・カタカナの場合は複合語の一部とみなして採用しない。
 */
function matchesAsWord(itemName: string, word: string): boolean {
  if (Array.from(word).length > 1) return itemName.includes(word);

  const compoundChar = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/u;
  let from = 0;
  for (;;) {
    const index = itemName.indexOf(word, from);
    if (index === -1) return false;
    const before = index === 0 ? '' : itemName[index - 1]!;
    const after = itemName[index + word.length] ?? '';
    // 前後どちらかが漢字・かなだと複合語の可能性が高い（吸水・水圧・水着など）
    if (!compoundChar.test(before) && !compoundChar.test(after)) return true;
    from = index + 1;
  }
}

/**
 * 商品名からカテゴリ語を取り出す。見つからなければジャンル名の先頭セグメントを使う。
 *
 * **商品名の中で最も早く出てくる語を選ぶ。**
 * 楽天の商品名は先頭が実際の商品で、後半は検索用のキーワードが並ぶ。
 * リストの並び順で選ぶと、後半のキーワードを拾って別の商品の紹介文になる。
 * 実例: 骨取りさばの商品名の後半に「プロテイン」があり、
 * 「プロテインならレビュー35,712件」という投稿文が生成されていた。
 * 同じ位置なら長い語を優先する（「コーヒー」より「インスタントコーヒー」）。
 */
export function extractNoun(itemName: string, genreName: string): string {
  let best: { word: string; index: number } | null = null;
  for (const word of CATEGORY_WORDS) {
    if (!matchesAsWord(itemName, word)) continue;
    const index = itemName.indexOf(word);
    if (index === -1) continue;
    if (
      best === null ||
      index < best.index ||
      (index === best.index && Array.from(word).length > Array.from(best.word).length)
    ) {
      best = { word, index };
    }
  }
  if (best !== null) return best.word;

  const segment = genreName.split(/[・\/]/)[0]?.trim();
  return segment && segment !== '' ? segment : '毎日使うもの';
}

export interface UnitInfo {
  count: number;
  unit: string;
  unitPrice: number;
}

/** 「500ml×24本」のような表記から 1本あたりの単価を求める */
export function extractUnitPrice(itemName: string, price: number): UnitInfo | null {
  if (price <= 0) return null;
  UNIT_PATTERN.lastIndex = 0;
  let best: { count: number; unit: string } | null = null;
  let match: RegExpExecArray | null;
  while ((match = UNIT_PATTERN.exec(itemName)) !== null) {
    const count = Number(match[1]);
    const unit = match[2]!;
    if (!Number.isFinite(count) || count < 2 || count > 5000) continue;
    if (best === null || count > best.count) best = { count, unit };
  }
  if (best === null) return null;
  const unitPrice = Math.round(price / best.count);
  if (unitPrice < 1) return null;
  return { count: best.count, unit: best.unit, unitPrice };
}

/** 期間限定価格の期限を「8/3まで」の形にする。JSTで判定する */
export function deadlineLabel(priceEndTime: string | null | undefined): string | null {
  if (!priceEndTime) return null;
  const t = Date.parse(priceEndTime);
  if (Number.isNaN(t)) return null;
  const jst = new Date(t + 9 * 3600000);
  return `${jst.getUTCMonth() + 1}/${jst.getUTCDate()}まで`;
}

export function scoreAngles(input: CommentInput, unit: UnitInfo | null): Array<{ angle: Angle; score: number }> {
  const name = input.itemName;
  const season = seasonOf(input.month);

  const bulk = BULK_WORDS.filter((w) => name.includes(w)).length;
  const stock = STOCK_WORDS.filter((w) => name.includes(w)).length;
  const meal = MEAL_WORDS.filter((w) => name.includes(w)).length;
  const seasonHits = SEASON_WORDS[season].filter((w) => name.includes(w)).length;
  const hasDeadline = deadlineLabel(input.priceEndTime) !== null;

  return [
    { angle: '手間削減' as Angle, score: bulk * 2 + (input.postageFlag === 0 ? 1 : 0) },
    { angle: 'ストック切れ回避' as Angle, score: stock * 2 },
    { angle: '献立負担' as Angle, score: meal * 3 },
    { angle: 'コスパ比較' as Angle, score: unit ? 3 + Math.min(unit.count / 12, 3) : 0 },
    { angle: '季節' as Angle, score: seasonHits * 3 },
    // 期限やポイント倍率が無いと価格を訴求できないため、その場合は候補にしない
    { angle: 'セール速報' as Angle, score: hasDeadline ? 6 : input.pointRate >= 5 ? 4 : 0 },
  ];
}

/** 同点時の優先順位。仕様書に定めが無いため、汎用性の高い順に固定する */
const ANGLE_PRIORITY: Angle[] = ['セール速報', 'ストック切れ回避', '献立負担', '手間削減', 'コスパ比較', '季節'];

export function selectAngles(input: CommentInput, unit: UnitInfo | null, count = 3): Angle[] {
  const scored = scoreAngles(input, unit);
  const byAngle = new Map(scored.map((s) => [s.angle, s.score]));

  const ordered = [...ANGLE_PRIORITY].sort((a, b) => {
    const diff = (byAngle.get(b) ?? 0) - (byAngle.get(a) ?? 0);
    if (diff !== 0) return diff;
    return ANGLE_PRIORITY.indexOf(a) - ANGLE_PRIORITY.indexOf(b);
  });

  const usable = ordered.filter((angle) => {
    // 成立しない角度は落とす。コスパは単価、セール速報は期限かポイント倍率が必要
    if (angle === 'コスパ比較') return unit !== null;
    if (angle === 'セール速報') return (byAngle.get('セール速報') ?? 0) > 0;
    // 商品名に手がかりが無い角度は当てはまらない。
    // 例: 珪藻土バスマットに「献立負担」が付くと、まるで別の商品の紹介文になる
    return (byAngle.get(angle) ?? 0) > 0;
  });

  // すべて0点なら、汎用性の高い順に先頭だけ使う（案が0件になるのを防ぐ）
  if (usable.length === 0) return [ordered.find((a) => a !== 'コスパ比較' && a !== 'セール速報') ?? '手間削減'];
  return usable.slice(0, Math.max(1, count));
}

function charLength(text: string): number {
  return Array.from(text).length;
}

/** 文末の「。」を落とす。プロンプトの「文末を『。』で終わらせない」に合わせる */
function dropPeriod(line: string): string {
  return line.replace(/[。．]+$/u, '');
}

/** 商品名の書き出しをそのまま流用していないか */
function startsWithItemName(line: string, itemName: string): boolean {
  const head = Array.from(itemName.trim()).slice(0, 4).join('');
  return head.length >= 2 && line.startsWith(head);
}

export function hasBannedWord(text: string, ngWords: NgWordsConfig): string | null {
  return containsAny(text, ngWords.commentBanned) ?? containsAny(text, ngWords.health);
}

/* ---------- 1. ヘッダー（約20文字・数字を必ず1つ） ---------- */

/**
 * ヘッダーに入れる数字。プロンプトの「必ず数字を1つ入れる」を満たすために使う。
 * 単価 > 数量 > ポイント倍率 > レビュー件数 の順に、読み手に効く順で選ぶ。
 */
export function headerNumber(input: CommentInput, unit: UnitInfo | null): string | null {
  if (unit) return `1${unit.unit}${unit.unitPrice}円`;
  if (input.pointRate >= 5) return `ポイント${input.pointRate}倍`;
  if (input.reviewCount >= 100) return `レビュー${input.reviewCount.toLocaleString('en-US')}件`;
  if (input.itemPrice > 0) return `${input.itemPrice.toLocaleString('en-US')}円`;
  return null;
}

function headerTemplates(angle: Angle, input: CommentInput, noun: string, unit: UnitInfo | null): string[] {
  const season = seasonOf(input.month);
  const num = headerNumber(input, unit);
  const qty = unit ? `${unit.count}${unit.unit}` : null;
  const deadline = deadlineLabel(input.priceEndTime);

  switch (angle) {
    case 'セール速報':
      return [
        deadline && num ? `⏰${deadline} ${num}は見逃せない` : '',
        deadline && num ? `⏰${deadline} ${num}` : '',
        deadline ? `⏰${deadline}の${noun}、今が判断どき` : '',
        input.pointRate >= 5 ? `ポイント${input.pointRate}倍のうちに${noun}を確保` : '',
        num ? `${num}は今のうちに決めたい` : '',
      ].filter(Boolean);
    case 'コスパ比較':
      return [
        unit ? `1${unit.unit}${unit.unitPrice}円、単価で選ぶならこれ` : '',
        unit ? `${qty}で1${unit.unit}${unit.unitPrice}円まで下がる` : '',
        unit ? `1${unit.unit}${unit.unitPrice}円、まとめる価値あり` : '',
        unit ? `${noun}を1${unit.unit}${unit.unitPrice}円で回せる` : '',
        unit ? `1${unit.unit}${unit.unitPrice}円まで下げられる${noun}` : '',
      ].filter(Boolean);
    case '献立負担':
      return [
        qty ? `${qty}、出すだけで一品になる` : '',
        num ? `${num}、作らない日の保険になる` : '',
        qty ? `もう作りたくない日のための${qty}` : '',
      ].filter(Boolean);
    case '手間削減':
      return [
        qty ? `${qty}届いて買い出しがゼロになる` : '',
        num ? `${num}、運ぶ手間がまるごと消える` : '',
        qty ? `${noun}の買い足しは${qty}で終わる` : '',
      ].filter(Boolean);
    case 'ストック切れ回避':
      return [
        qty ? `${qty}あれば切らす心配がない` : '',
        num ? `${num}、切らして慌てなくなる` : '',
        qty ? `${noun}を${qty}ストックできる安心` : '',
      ].filter(Boolean);
    case '季節':
      return [
        qty ? `${SEASON_LEAD[season]}のために${qty}を確保` : '',
        num ? `${SEASON_LEAD[season]}に備えるなら${num}` : '',
        qty ? `${SEASON_LEAD[season]}は${qty}あれば足りる` : '',
        num ? `${SEASON_LEAD[season]}の${noun}が${num}` : '',
      ].filter(Boolean);
  }
}

function buildHeader(
  angle: Angle,
  input: CommentInput,
  noun: string,
  unit: UnitInfo | null,
  scoring: ScoringConfig,
  ngWords: NgWordsConfig,
): string {
  const { firstLineMin, firstLineMax } = scoring.comment;
  const num = headerNumber(input, unit);
  const candidates = headerTemplates(angle, input, noun, unit).map(dropPeriod);

  // 単価も数量も取れない商品（本数表記が無いもの）はテンプレートが空になる。
  // その場合でも数字入りのヘッダーを作れるよう、長さの違う候補を用意する
  if (num) {
    candidates.push(
      `${num}のうちに${noun}を確保したい`,
      `${noun}のまとめ買いは${num}から`,
      `${num}、${noun}を切らす前に`,
      `${num}の${noun}`,
      `${noun}なら${num}`,
    );
  }
  candidates.push(`まとめておくと安心な${noun}`);

  const valid = candidates.filter(
    (c) => c !== '' && !startsWithItemName(c, input.itemName) && hasBannedWord(c, ngWords) === null,
  );
  const inRange = valid.filter((c) => {
    const len = charLength(c);
    return len >= firstLineMin && len <= firstLineMax;
  });

  // 数字が入っているものを優先し、その中で目標文字数に近いものを選ぶ（決定的）
  const mid = (firstLineMin + firstLineMax) / 2;
  const pick = (list: string[]) =>
    [...list].sort((a, b) => {
      const na = /\d/.test(a) ? 0 : 1;
      const nb = /\d/.test(b) ? 0 : 1;
      if (na !== nb) return na - nb;
      const d = Math.abs(charLength(a) - mid) - Math.abs(charLength(b) - mid);
      return d !== 0 ? d : a.localeCompare(b);
    })[0]!;

  if (inRange.length > 0) return pick(inRange);

  // 範囲に収まらない場合は上限で切る。フィードで切れるより短い方が害が小さい
  const fallback = valid.length > 0 ? valid : candidates.filter((c) => c !== '');
  return Array.from(pick(fallback)).slice(0, firstLineMax).join('');
}

/* ---------- 2. ボディ（結論→理由→共感） ---------- */

/** 結論：一番のメリットを1つだけ、短く。複数並べない */
function conclusionTemplates(angle: Angle, input: CommentInput, noun: string, unit: UnitInfo | null): string[] {
  const season = seasonOf(input.month);
  switch (angle) {
    case 'セール速報':
      return ['この価格のうちに確保しておきたい', '期間が切れる前に決めたいところ'];
    case 'コスパ比較':
      return unit
        ? [`1${unit.unit}あたり${unit.unitPrice}円、コスパで選ぶならこれ`, `単価で見ると景色が変わる`]
        : ['まとめるほど1回あたりの負担は軽くなる'];
    case '献立負担':
      return ['出すだけで一品になるのが効く', '作らない日の逃げ道が1つ増える'];
    case '手間削減':
      return ['買い出しの回数がそのまま減る', '運ぶ・選ぶ・並ぶをまとめて省ける'];
    case 'ストック切れ回避':
      return [`${noun}を切らして慌てることが無くなる`, '「無い」と気づく前に補充できる状態になる'];
    case '季節':
      return [`${SEASON_LEAD[season]}は減りが早いので先に確保しておきたい`, `${SEASON_LEAD[season]}の買い足しを1回で終わらせる`];
  }
}

/**
 * 理由：✅の箇条書き2〜3項目。
 * プロンプトの「✅の中身は角度ごとに変える」に従い、角度別に組む。
 * スペック（容量・本数・価格・送料・期限）は言い切ってよい要素だけを使う。
 */
function checkItems(angle: Angle, input: CommentInput, unit: UnitInfo | null): string[] {
  const items: string[] = [];
  const deadline = deadlineLabel(input.priceEndTime);
  const free = input.postageFlag === 0;

  if (angle === 'セール速報') {
    if (deadline) items.push(deadline);
    if (input.pointRate >= 5) items.push(`ポイント${input.pointRate}倍`);
    if (unit) items.push(`1${unit.unit}${unit.unitPrice}円`);
  } else if (angle === 'コスパ比較') {
    if (unit) items.push(`1${unit.unit}あたり${unit.unitPrice}円`, `${unit.count}${unit.unit}入り`);
  } else if (angle === '献立負担') {
    if (unit) items.push(`${unit.count}${unit.unit}を小分けで使える`);
    items.push('出すだけで一品');
  } else if (angle === '手間削減') {
    if (unit) items.push(`まとめて${unit.count}${unit.unit}`);
    items.push('買い足しの回数が減る');
  } else if (angle === 'ストック切れ回避') {
    if (unit) items.push(`${unit.count}${unit.unit}ストックできる`);
    items.push('切らす前に補充できる');
  } else {
    if (unit) items.push(`${unit.count}${unit.unit}入り`);
    items.push(`${SEASON_LEAD[seasonOf(input.month)]}に備えられる`);
  }

  if (free && items.length < 3) items.push('送料込み');
  if (input.reviewCount >= 500 && items.length < 3) {
    items.push(`レビュー${input.reviewCount.toLocaleString('en-US')}件`);
  }
  return items.slice(0, 3);
}

/**
 * 補足：スペックの言い切り。
 * 容量・本数・価格・送料・レビュー件数は商品ページ記載の事実なので、伝聞にせず書ける。
 * 味・食感・満足度は実際に食べないと分からないため、ここには入れない。
 */
function supportTemplates(input: CommentInput, unit: UnitInfo | null): string[] {
  const out: string[] = [];
  if (input.reviewCount >= 100 && input.reviewAverage > 0) {
    out.push(`レビューは${input.reviewCount.toLocaleString('en-US')}件で平均${input.reviewAverage.toFixed(1)}`);
  }
  if (unit && input.itemPrice > 0) {
    out.push(`${unit.count}${unit.unit}で${input.itemPrice.toLocaleString('en-US')}円、割ると1${unit.unit}${unit.unitPrice}円`);
  }
  if (input.pointRate >= 5) out.push(`ポイント${input.pointRate}倍の期間に合わせると負担が変わる`);
  if (input.postageFlag === 0) out.push('送料込みの価格なので他と比べるときも計算しやすい');
  // 行を足さない選択肢も残す（短い商品名で上限を超えないように）
  out.push('');
  return out;
}

/** 共感：どんな場面で効くか。体験談を装わず、読み手の生活場面を描く */
function sceneTemplates(angle: Angle, input: CommentInput, noun: string): string[] {
  const scene = SEASON_SCENE[seasonOf(input.month)];
  switch (angle) {
    case 'セール速報':
      return ['迷っているうちに期間が終わるのがいちばん惜しい', `${scene}に効いてくる`];
    case 'コスパ比較':
      return ['毎日のものだから、単価の差がそのまま積み上がる', '同じ量を都度買うより計算がしやすい'];
    case '献立負担':
      return ['金曜の夜、もう何も作りたくない日に効く', '帰りが遅くなった日の献立がひとつ埋まる'];
    case '手間削減':
      return ['重いものを運ぶ日が無くなるだけで週末が軽い', `${scene}の買い出しがまるごと減る`];
    case 'ストック切れ回避':
      return [`${noun}が無いことに気づくのは、いつも夜`, '棚に余裕があるだけで平日の気持ちが違う'];
    case '季節':
      return [`${scene}に、買い足しに走らずに済む`, `${scene}こそ余裕を持たせておきたい`];
  }
}

/**
 * 4. 導入部：楽天市場へ送り出す一文。押し売りにしない。
 * 長短をそろえておき、全体の文字数を目標に収めるための調整幅にする。
 */
function outroTemplates(input: CommentInput): string[] {
  const out: string[] = [];
  if (deadlineLabel(input.priceEndTime)) {
    out.push('セール期限だけ先に見ておくと安心です');
    out.push('期限が近いので、残り日数だけ確認しておいてください');
  }
  out.push('容量とレビューは商品ページで確認できます');
  out.push('サイズ違いもあるので、比べてみてください');
  out.push('内容量と発送日は商品ページで確認できます');
  out.push('まとめ買いの単位も選べるので、比べてみてください');
  out.push('条件を見てから決めてみてください');
  return out;
}

/* ---------- 5. ハッシュタグ ---------- */

/** 感情・行動タグ。プロンプトが「必ず1つ」と定めている */
const FEELING_TAGS: Record<Angle, string> = {
  手間削減: '#買ってよかった',
  ストック切れ回避: '#ストックしてる',
  献立負担: '#リピート決定',
  コスパ比較: '#買ってよかった',
  季節: '#ストックしてる',
  セール速報: '#リピート決定',
};

const ANGLE_TAGS: Record<Angle, string> = {
  手間削減: '#時短',
  ストック切れ回避: '#ストック管理',
  献立負担: '#献立',
  コスパ比較: '#コスパ重視',
  季節: '#季節の買い物',
  セール速報: '#セール中',
};

function buildHashtags(angle: Angle, input: CommentInput, noun: string, scoring: ScoringConfig): string[] {
  const normalized = noun.replace(/[^\p{Letter}\p{Number}]/gu, '');
  const deadline = deadlineLabel(input.priceEndTime);

  const pool = [
    // カテゴリ系
    normalized !== '' ? `#${normalized}` : '#まとめ買い',
    ANGLE_TAGS[angle],
    // 感情・行動タグ（必須）
    FEELING_TAGS[angle],
    // 悩み・属性系
    '#共働き',
    // 期間・価格系（該当時）
    deadline ? `#${deadline.replace('/', '_')}` : '',
    input.postageFlag === 0 ? '#送料込み' : '',
  ].filter((t) => t !== '');

  const unique: string[] = [];
  for (const tag of pool) {
    if (!unique.includes(tag)) unique.push(tag);
    if (unique.length >= scoring.comment.hashtagMax) break;
  }
  while (unique.length < scoring.comment.hashtagMin) unique.push('#暮らしの記録');
  return unique;
}

/* ---------- 組み立て ---------- */

function buildBody(
  angle: Angle,
  input: CommentInput,
  noun: string,
  unit: UnitInfo | null,
  header: string,
  scoring: ScoringConfig,
  ngWords: NgWordsConfig,
): string[] {
  const { totalMin, totalMax, maxLines } = scoring.comment;
  const clean = (list: string[]) => list.map(dropPeriod).filter((t) => t !== '' && hasBannedWord(t, ngWords) === null);

  const conclusions = clean(conclusionTemplates(angle, input, noun, unit));
  const checks = checkItems(angle, input, unit).filter((t) => hasBannedWord(t, ngWords) === null);
  const scenes = clean(sceneTemplates(angle, input, noun));
  const outros = clean(outroTemplates(input));
  // 補足は入れない選択肢も持つため、空文字を残したまま整える
  const supports = supportTemplates(input, unit)
    .map(dropPeriod)
    .filter((t) => t === '' || hasBannedWord(t, ngWords) === null);

  // ✅ の行。項目が無いときは行そのものを作らない
  const checkLines = checks.length > 0 ? [checks.map((c) => `✅${c}`).join(' ')] : [''];

  let best: { lines: string[]; distance: number } | null = null;

  for (const conclusion of conclusions) {
    for (const checkLine of checkLines) {
      for (const support of supports) {
        for (const scene of scenes) {
          for (const outro of outros) {
            const lines = [header, conclusion, checkLine, support, scene, outro].filter((l) => l !== '');
            if (lines.length > maxLines) continue;
            const total = lines.reduce((sum, l) => sum + charLength(l), 0);
            if (total >= totalMin && total <= totalMax) return lines;

            const distance = total < totalMin ? totalMin - total : total - totalMax;
            if (best === null || distance < best.distance) best = { lines, distance };
          }
        }
      }
    }
  }
  return best?.lines ?? [header];
}

export function buildDraftComment(
  angle: Angle,
  input: CommentInput,
  scoring: ScoringConfig,
  ngWords: NgWordsConfig,
): DraftComment {
  const noun = extractNoun(input.itemName, input.genreName);
  const unit = extractUnitPrice(input.itemName, input.itemPrice);
  const header = buildHeader(angle, input, noun, unit, scoring, ngWords);
  const lines = buildBody(angle, input, noun, unit, header, scoring, ngWords);

  return {
    angle,
    text: lines.join('\n'),
    firstLine: header,
    firstLineLength: charLength(header),
    hashtags: buildHashtags(angle, input, noun, scoring),
  };
}

/** 商品に合う角度を選んで案を作る。件数は config/scoring.json の draftCount */
export function buildDraftComments(
  input: CommentInput,
  scoring: ScoringConfig,
  ngWords: NgWordsConfig,
): DraftComment[] {
  const unit = extractUnitPrice(input.itemName, input.itemPrice);
  const count = scoring.comment.draftCount ?? 3;
  return selectAngles(input, unit, count).map((angle) => buildDraftComment(angle, input, scoring, ngWords));
}

export interface CommentViolation {
  rule: string;
  detail: string;
}

/** テストと開発時の自己点検用。生成物がプロンプトの型を満たしているか検査する */
export function validateComment(
  draft: DraftComment,
  scoring: ScoringConfig,
  ngWords: NgWordsConfig,
  itemName: string,
): CommentViolation[] {
  const c = scoring.comment;
  const violations: CommentViolation[] = [];
  const lines = draft.text.split('\n');
  const total = lines.reduce((sum, line) => sum + charLength(line), 0);

  if (draft.firstLineLength < c.firstLineMin || draft.firstLineLength > c.firstLineMax) {
    violations.push({
      rule: 'headerLength',
      detail: `${draft.firstLineLength}文字（${c.firstLineMin}〜${c.firstLineMax}）`,
    });
  }
  if (total < c.totalMin || total > c.totalMax) {
    violations.push({ rule: 'totalLength', detail: `${total}文字（${c.totalMin}〜${c.totalMax}）` });
  }
  if (lines.length > c.maxLines) {
    violations.push({ rule: 'maxLines', detail: `${lines.length}行` });
  }
  if (draft.hashtags.length < c.hashtagMin || draft.hashtags.length > c.hashtagMax) {
    violations.push({ rule: 'hashtagCount', detail: `${draft.hashtags.length}個` });
  }
  if (new Set(draft.hashtags).size !== draft.hashtags.length) {
    violations.push({ rule: 'hashtagDuplicate', detail: draft.hashtags.join(' ') });
  }
  // 感情・行動タグが必ず1つ入っていること
  if (!draft.hashtags.some((t) => Object.values(FEELING_TAGS).includes(t))) {
    violations.push({ rule: 'feelingTagMissing', detail: draft.hashtags.join(' ') });
  }
  const banned = hasBannedWord(draft.text, ngWords);
  if (banned !== null) {
    violations.push({ rule: 'bannedWord', detail: banned });
  }
  if (startsWithItemName(draft.firstLine, itemName)) {
    violations.push({ rule: 'startsWithItemName', detail: draft.firstLine });
  }
  // ヘッダーに数字を1つ入れる
  if (!/\d/.test(draft.firstLine)) {
    violations.push({ rule: 'headerHasNoNumber', detail: draft.firstLine });
  }
  // 文末を「。」で終わらせない
  const withPeriod = lines.filter((l) => /[。．]$/u.test(l));
  if (withPeriod.length > 0) {
    violations.push({ rule: 'endsWithPeriod', detail: withPeriod.join(' / ') });
  }
  return violations;
}
