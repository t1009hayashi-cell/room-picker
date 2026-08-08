import type { DraftComment, NgWordsConfig, ScoringConfig } from './types.js';
import { containsAny } from './filter.js';

/**
 * 投稿文の生成。
 *
 * 型は `プロンプト/room_post_prompt_final.md`（ユーザーが実際にAIへ投げている指示）に合わせている。
 * 仕様書 9.1 とは大きく違うが、**プロンプト側を正とする。**
 *
 * 上位投稿はほぼ例外なくこの4層（プロンプトの実測）:
 *   第1層 フック（冒頭1行・20〜30文字）
 *   第2層 記号付き箇条書き 3〜5行 ※実測40件中38件が使用
 *   第3層 使用シーンの描写 3〜6行
 *   第4層 CTA ＋ 罫線 ＋ ハッシュタグ10〜15個
 *
 * 実測に基づく重要な決まりごと:
 *  - **冒頭に割引率を置かない。** 条件訴求は下位グループの標準装備で、上位に押し上げる力はない。
 *    第一選択は共感課題型、第二選択は状況名指し型。価格は箇条書きの行に格納する
 *  - **1行20〜24文字で改行する。** 上位ほど1行が短い（1〜10位=21文字／31〜50位=29文字）
 *  - **レビュー件数と評価点は原則書かない。** 実測で50件中2件しか書いていない。
 *    例外は1万件超か、受賞などの固定された称号
 *  - 文末を「。」で終わらせない
 *  - 使用体験を装わない。書けない分は生活場面の解像度で埋める
 *  - 「〜な人へ」「〜におすすめ」は使わない（広告の言い方になる）
 */

/** 投稿プロンプトの「5案の作り方」に載っている角度 */
export const ANGLES = [
  'スーパーにない型',
  '評判の裏取り型',
  'セール速報型',
  '献立負担型',
  'ストック切れ回避型',
  '季節型',
  'ギフト型',
] as const;
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
  /** 期間限定価格の終了日時（ISO） */
  priceEndTime?: string | null;
  /** 割引率（%）。抽出できていなければ null */
  discountRate?: number | null;
  hasCoupon?: boolean;
  /** クーポン・割引の期限の生表記（例: 8/11まで） */
  couponDeadlineRaw?: string | null;
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

type Season = 'spring' | 'summer' | 'autumn' | 'winter';

const SEASON_WORDS: Record<Season, string[]> = {
  spring: ['新生活', '入学', '花見', '母の日', '春'],
  summer: ['麦茶', '炭酸水', '冷', 'アイス', 'そうめん', 'スポーツドリンク', 'ゼリー', '夏'],
  autumn: ['栗', 'さつまいも', 'ハロウィン', '秋', '新米'],
  winter: ['ホット', '鍋', '福袋', 'あったか', 'ココア', 'おでん', '冬'],
};

/**
 * 冒頭に置く共感課題（第一選択）。
 * プロンプトの「描く場面のストック」から取っている。
 * **主語は書かない。** 状況だけ置けば、当てはまる人が自分のことだと思う。
 */
const SEASON_HOOKS: Record<Season, string[]> = {
  spring: ['新学期って、朝の支度が一気に増える', '春休みの昼ごはん、もうネタが尽きた'],
  summer: ['夏休みのお昼ごはん、もうネタが尽きた', '暑いと火を使う気力がなくなる'],
  autumn: ['行事が続くと、夕飯まで手が回らない', '涼しくなると、食べる量が急に増える'],
  winter: ['寒い日は買い物に出るのが億劫になる', '受験期の夜食、何を出すか毎日迷う'],
};

/** 商品を問わず使える共感課題。プロンプトの「描く場面のストック」より */
const COMMON_HOOKS = [
  '部活から帰ってすぐ「お腹すいた」が来る',
  '今日の夕飯どうしよう、が毎日来る',
  '塾の前に何か食べさせたいのに時間がない',
  '家族の帰宅がバラバラで夕飯が2回に分かれる',
  '朝、弁当の主菜が決まらない',
  '育ち盛りに我慢してとは言えない',
];

const BULK_WORDS = ['まとめ買い', 'ケース', '箱', '大容量', '業務用', '詰め替え', '詰替', 'セット', '×', 'ラベルレス'];
const STOCK_WORDS = ['まとめ買い', 'ケース', '箱', '業務用', '大容量', 'ストック', '常備', '長期保存', '入', 'セット'];
const MEAL_WORDS = ['冷凍', '骨取り', '骨なし', 'カット', '味付', '総菜', 'そうざい', 'おかず', 'レンジ', '湯煎', '下処理', '時短'];
/** 「スーパーにない」の手がかり。プロンプトの基準の判定より */
const NOT_IN_STORE_WORDS = ['業務用', '大容量', '骨取り', '骨なし', 'カット済', '産地直送', '専門店', '取り寄せ', 'kg', '2kg', '訳あり'];
/** 固定された称号。変動する数値より効く（実測で上位10位の40%） */
const TITLE_WORDS = ['グルメ大賞', '受賞', 'モンドセレクション', 'TV', 'テレビ', '紹介', '楽天ランキング', '殿堂'];
const GIFT_WORDS = ['ギフト', '贈答', 'お中元', 'お歳暮', '内祝', 'プレゼント', '詰め合わせ', '化粧箱'];

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
    if (!compoundChar.test(before) && !compoundChar.test(after)) return true;
    from = index + 1;
  }
}

/**
 * 商品名からカテゴリ語を取り出す。**商品名の中で最も早く出てくる語**を選ぶ。
 * 楽天の商品名は後半に検索用キーワードが並ぶため、リスト順で選ぶと別物を拾う。
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

/** その商品が「スーパーにない」と言えるか。単価を出してよいかの判定も兼ねる */
export function isNotInStore(itemName: string): boolean {
  return NOT_IN_STORE_WORDS.some((w) => itemName.includes(w));
}

export function scoreAngles(input: CommentInput, unit: UnitInfo | null): Array<{ angle: Angle; score: number }> {
  const name = input.itemName;
  const season = seasonOf(input.month);

  const bulk = BULK_WORDS.filter((w) => name.includes(w)).length;
  const stock = STOCK_WORDS.filter((w) => name.includes(w)).length;
  const meal = MEAL_WORDS.filter((w) => name.includes(w)).length;
  const seasonHits = SEASON_WORDS[season].filter((w) => name.includes(w)).length;
  const notInStore = NOT_IN_STORE_WORDS.filter((w) => name.includes(w)).length;
  const titles = TITLE_WORDS.filter((w) => name.includes(w)).length;
  const gift = GIFT_WORDS.filter((w) => name.includes(w)).length;

  const deadline = deadlineLabel(input.priceEndTime) ?? input.couponDeadlineRaw ?? null;
  const hasDeal = (input.discountRate ?? 0) > 0 || Boolean(input.hasCoupon) || deadline !== null;

  return [
    { angle: 'スーパーにない型' as Angle, score: notInStore * 3 + bulk },
    // 固定された称号は変動する数値より効く（実測）
    { angle: '評判の裏取り型' as Angle, score: titles * 4 + (input.reviewCount >= 10000 ? 3 : 0) },
    { angle: 'セール速報型' as Angle, score: hasDeal ? 6 : input.pointRate >= 5 ? 4 : 0 },
    { angle: '献立負担型' as Angle, score: meal * 3 },
    { angle: 'ストック切れ回避型' as Angle, score: stock * 2 },
    { angle: '季節型' as Angle, score: seasonHits * 3 },
    // 食品でギフトは弱い（実測で上位10件中2件）。スイーツ側の文脈
    { angle: 'ギフト型' as Angle, score: gift * (input.genreName.includes('スイーツ') ? 3 : 1) },
  ];
}

/** 同点時の優先順位。プロンプトの主力文脈（消耗品×調理負担の軽減）を上に置く */
const ANGLE_PRIORITY: Angle[] = [
  '献立負担型',
  'スーパーにない型',
  'セール速報型',
  'ストック切れ回避型',
  '評判の裏取り型',
  '季節型',
  'ギフト型',
];

export function selectAngles(input: CommentInput, unit: UnitInfo | null, count = 3): Angle[] {
  const scored = scoreAngles(input, unit);
  const byAngle = new Map(scored.map((s) => [s.angle, s.score]));

  const ordered = [...ANGLE_PRIORITY].sort((a, b) => {
    const diff = (byAngle.get(b) ?? 0) - (byAngle.get(a) ?? 0);
    if (diff !== 0) return diff;
    return ANGLE_PRIORITY.indexOf(a) - ANGLE_PRIORITY.indexOf(b);
  });

  // 商品名に手がかりが無い角度は当てはまらない（別商品の紹介文になる）
  const usable = ordered.filter((angle) => (byAngle.get(angle) ?? 0) > 0);
  if (usable.length === 0) return ['ストック切れ回避型'];
  return usable.slice(0, Math.max(1, count));
}

function charLength(text: string): number {
  return Array.from(text).length;
}

/** 文末の「。」を落とす */
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

/**
 * 長い行を目安の文字数で折る。
 * 実測で上位ほど1行が短い。句読点の位置を優先し、無ければ目安で切る。
 */
export function wrapLine(line: string, target: number): string[] {
  const chars = Array.from(line);
  if (chars.length <= target) return [line];

  const hiragana = /[\p{Script=Hiragana}ー]/u;

  const out: string[] = [];
  let rest = chars;
  while (rest.length > target) {
    // 目安の手前でいちばん後ろにある区切りを探す
    let cut = -1;
    for (let i = Math.min(target, rest.length - 1); i >= Math.floor(target / 2); i -= 1) {
      if (/[、。，,・]/u.test(rest[i]!)) {
        cut = i + 1;
        break;
      }
    }
    if (cut === -1) {
      // 句読点が無い場合は**文節の切れ目**で折る。
      // 日本語は「名詞＋助詞」で区切れるので、ひらがな（助詞）の直後に
      // ひらがな以外（次の文節の先頭）が来る位置を探す。
      // 機械的に切ると「積み上／がっていく」「結／局早い」のように語が割れて読めなくなる。
      const han = /\p{Script=Han}/u;
      for (let i = Math.min(target, rest.length - 1); i >= Math.floor(target / 2); i -= 1) {
        if (!hiragana.test(rest[i - 1]!) || hiragana.test(rest[i]!)) continue;
        // 「積み上がる」のように 漢字＋送り仮名＋漢字 が続く場合、その真ん中は
        // 文節の切れ目ではなく語の途中なので切らない
        if (i >= 2 && han.test(rest[i - 2]!)) continue;
        cut = i;
        break;
      }
    }
    // それでも見つからなければ目安で切る（記号だけの行など）
    if (cut === -1) cut = target;
    out.push(rest.slice(0, cut).join('').trim());
    rest = rest.slice(cut);
  }
  if (rest.length > 0) out.push(rest.join('').trim());
  return out.filter((l) => l !== '');
}

/* ---------- 第1層 フック（冒頭1行・20〜30文字） ---------- */

/**
 * 冒頭1行の候補。
 * **割引があっても冒頭に割引率を置かない。** 実測で条件訴求は下位の標準装備。
 * 第一選択は共感課題型、第二選択は状況名指し型。
 */
function hookTemplates(angle: Angle, input: CommentInput, noun: string): string[] {
  const season = seasonOf(input.month);
  const seasonHooks = SEASON_HOOKS[season];

  // 角度ごとの状況名指し（第二選択）
  const situational: Record<Angle, string[]> = {
    献立負担型: ['作りたくない日の逃げ道がひとつ増えた', '帰りが遅い日の夕飯がひとつ埋まる'],
    スーパーにない型: [`${noun}はスーパーだとこの形で置いていない`, `この${noun}、近所では見かけない`],
    セール速報型: ['買い足すなら今週のうちがよさそう', '価格が動いているうちに決めたい'],
    ストック切れ回避型: [`${noun}を切らした日の焦りがなくなる`, `${noun}が無いと気づくのはいつも夜`],
    評判の裏取り型: ['選ばれ続けている理由がちゃんとある', '迷ったときに外さない方を選びたい'],
    季節型: seasonHooks,
    ギフト型: ['手土産が決まらないまま当日が近づく', '渡す相手の顔が浮かぶものを選びたい'],
  };

  // 共感課題型（第一選択）を先に置く
  return [...seasonHooks, ...COMMON_HOOKS, ...situational[angle]];
}

function buildHook(
  angle: Angle,
  input: CommentInput,
  noun: string,
  scoring: ScoringConfig,
  ngWords: NgWordsConfig,
): string {
  const { firstLineMin, firstLineMax } = scoring.comment;
  const candidates = hookTemplates(angle, input, noun).map(dropPeriod);

  const valid = candidates.filter(
    (c) => c !== '' && !startsWithItemName(c, input.itemName) && hasBannedWord(c, ngWords) === null,
  );
  const inRange = valid.filter((c) => {
    const len = charLength(c);
    return len >= firstLineMin && len <= firstLineMax;
  });

  // 目標文字数に最も近いものを選ぶ（決定的）
  const mid = (firstLineMin + firstLineMax) / 2;
  const pick = (list: string[]) =>
    [...list].sort((a, b) => {
      const d = Math.abs(charLength(a) - mid) - Math.abs(charLength(b) - mid);
      return d !== 0 ? d : a.localeCompare(b);
    })[0]!;

  if (inRange.length > 0) return pick(inRange);
  const fallback = valid.length > 0 ? valid : candidates.filter((c) => c !== '');
  return Array.from(pick(fallback)).slice(0, firstLineMax).join('');
}

/* ---------- 第2層 記号付き箇条書き（3〜5行） ---------- */

/**
 * 商品名から拾える特徴。箇条書きの行数（3〜5行）を確保するために使う。
 * プロンプトの「スーパーにない理由（骨取り済み／2kg／業務用／産地直送）」に対応する。
 */
const FEATURE_RULES: Array<{ match: RegExp; label: string }> = [
  { match: /骨取り|骨なし/u, label: '骨取り済み' },
  { match: /小分け|個包装/u, label: '小分けで使える' },
  { match: /冷凍/u, label: '冷凍で届く' },
  { match: /業務用/u, label: '業務用サイズ' },
  { match: /大容量/u, label: '大容量' },
  { match: /常温/u, label: '常温で保存できる' },
  { match: /訳あり/u, label: '訳あり価格' },
  { match: /産地直送|直送/u, label: '産地直送' },
  { match: /レンジ|湯煎|湯せん/u, label: '温めるだけ' },
  { match: /カット済|カット/u, label: 'カット済み' },
  { match: /味付|味付き/u, label: '味付き' },
  { match: /化粧箱|箱入/u, label: '箱入りで渡せる' },
  { match: /詰め合わせ|詰合せ/u, label: '詰め合わせ' },
  { match: /無添加/u, label: '無添加' },
  { match: /国産/u, label: '国産' },
];

/** 内容量の表記（1kg・2kgなど）をそのまま箇条書きに使う */
const WEIGHT_PATTERN = /(\d+(?:\.\d+)?)\s*(kg|g|ml|L|リットル)/iu;

function featureBullets(itemName: string): string[] {
  const out: string[] = [];
  for (const rule of FEATURE_RULES) {
    if (rule.match.test(itemName)) out.push(rule.label);
  }
  const weight = WEIGHT_PATTERN.exec(itemName);
  if (weight) out.unshift(`${weight[1]}${weight[2]}`);
  return out;
}

/**
 * ✅の中身は角度ごとに変える（プロンプトの指示）。
 * 価格・割引率・期限・送料無料はここに格納する。冒頭には置かない。
 */
function bulletItems(angle: Angle, input: CommentInput, unit: UnitInfo | null): string[] {
  const items: string[] = [];
  const deadline = deadlineLabel(input.priceEndTime) ?? input.couponDeadlineRaw ?? null;
  const rate = input.discountRate ?? null;

  if (angle === 'セール速報型') {
    if (rate !== null) items.push(`${rate}%OFF`);
    if (deadline) items.push(deadline);
    if (input.hasCoupon) items.push('クーポンあり');
    if (input.pointRate >= 5) items.push(`ポイント${input.pointRate}倍`);
  } else if (angle === '評判の裏取り型') {
    // 固定された称号は効く。変動する数値は原則書かない（例外は1万件超）
    if (input.reviewCount >= 10000) items.push(`レビュー${input.reviewCount.toLocaleString('en-US')}件`);
  } else if (angle === 'スーパーにない型') {
    if (unit) items.push(`${unit.count}${unit.unit}入り`);
    // 単価はスーパーに同等品が無い商品にだけ出す（比較の土俵に自分から乗らない）
    if (unit && isNotInStore(input.itemName)) items.push(`1${unit.unit}あたり${unit.unitPrice}円`);
  } else if (angle === '献立負担型') {
    if (unit) items.push(`${unit.count}${unit.unit}を小分けで使える`);
    items.push('出すだけで一品');
  } else if (angle === 'ストック切れ回避型') {
    if (unit) items.push(`${unit.count}${unit.unit}まとめて置ける`);
    items.push('切らす前に補充できる');
  } else if (angle === 'ギフト型') {
    items.push('そのまま渡せる箱入り');
    if (unit) items.push(`${unit.count}${unit.unit}入り`);
  } else {
    if (unit) items.push(`${unit.count}${unit.unit}入り`);
  }

  // どの角度でも入れてよい条件系。冒頭ではなくここに置く
  if (rate !== null && !items.some((i) => i.includes('OFF'))) items.push(`${rate}%OFF`);
  if (deadline && !items.includes(deadline)) items.push(deadline);
  if (input.postageFlag === 0) items.push('送料無料');

  // 3〜5行に満たない場合は商品名から拾った特徴で埋める。
  // 実測で箇条書きは40件中38件が使用しており、事実上の必須フォーマット
  for (const feature of featureBullets(input.itemName)) {
    if (items.length >= 5) break;
    if (!items.some((i) => i.includes(feature))) items.push(feature);
  }

  const unique: string[] = [];
  for (const item of items) {
    if (item !== '' && !unique.includes(item)) unique.push(item);
  }
  return unique;
}

/* ---------- 第3層 使用シーンの描写（3〜6行） ---------- */

/**
 * 生活場面。体験を装わず、読み手の一日を描く（3〜6行）。
 * 体験談が書けない分をここの解像度で埋める。「金曜の夜」ではなく「部活から帰った直後」。
 */
function sceneTemplates(angle: Angle, input: CommentInput, noun: string): string[][] {
  const season = seasonOf(input.month);
  const seasonWord = season === 'summer' ? '暑い時期' : season === 'winter' ? '寒い時期' : 'この時期';

  // 文は長めに書いて wrapLine に 20〜24 字で折らせる。
  // 実測では上位の本文が322文字・15行（1行21.5字）で、短い行を並べるだけでは総量が足りない。
  switch (angle) {
    case '献立負担型':
      return [
        [
          '帰ってすぐ出せるものが冷凍庫にあるだけで、夕飯の組み立てはかなり変わる',
          '主菜が決まらない朝でも、これがあれば弁当箱がひとつ埋まる',
          '焼く、揚げる、煮る、味付けを変えれば続けても飽きにくい',
          '食べる分だけ取り出せるので、量の調整で悩まなくて済む',
        ],
        [
          '作る気力が残っていない日に、冷凍庫を開けるだけで済ませられる',
          '塾の前に何か出したいとき、待たせずに用意できるのが大きい',
          '献立を考える時間そのものが減るので、平日の負担が軽くなる',
        ],
      ];
    case 'スーパーにない型':
      return [
        [
          `この形の${noun}は近所の売り場ではまず見かけない`,
          '買いに行く前提で考えていると、そもそも選択肢に入ってこない',
          'まとめて置いておけるぶん、買い足しの回数まで変わってくる',
          '手に入る形が違うだけで、食卓の幅はひとつ広がる',
        ],
        [
          `同じ${noun}でも、下ごしらえまで済んでいるものは売り場に並ばない`,
          '取り寄せでしか手に入らないぶん、届いた日から使い方が変わる',
          '置き場所さえ確保できれば、あとは出すだけで回る',
        ],
      ];
    case 'セール速報型':
      return [
        [
          '価格が戻る前に確保しておきたいところ',
          '迷っている間に期間が終わるのが、いちばん惜しい',
          '普段づかいしているものほど、安いときにまとめておきたい',
          '次に同じ価格になるまで待つより、今のうちに動くほうが早い',
        ],
        [
          '期間が切れれば元の値段に戻るので、買い足す予定があるなら分かりやすい',
          'まとめ買いの単位も選べるので、置き場所に合わせて決められる',
          '価格だけで選ぶより、使い切れる量かどうかで見たい',
        ],
      ];
    case 'ストック切れ回避型':
      return [
        [
          '棚に余裕があるだけで、平日の気持ちはまるで違ってくる',
          '切らしたことに気づくのは、たいてい買い物に行けない夜',
          '先に置いておけば、その日に慌てて走らなくて済む',
          '補充のタイミングを考える手間ごと減らせる',
        ],
        [
          '無いと気づいてから買いに走るより、先に置いておくほうが早い',
          'まとめて届くので、買い足しの予定を気にしなくてよくなる',
          '使う量が読めるものほど、ストックしておく価値がある',
        ],
      ];
    case '評判の裏取り型':
      return [
        [
          '選ばれ続けているものは、結局いちばん外れが少ない',
          '迷って時間を使うより、実績のある方に寄せたほうが早い',
          '毎日のことだから、献立の軸に置けるかどうかで選びたい',
          '初めて買うものほど、続いている理由を見ておきたい',
        ],
        [
          '同じ用途のものが並んでいるとき、決め手になるのは積み重ね',
          '食材選びで失敗すると、その日の食卓ごと組み直しになる',
          '扱いに困らないものを選んでおくと、後がとにかく楽',
        ],
      ];
    case '季節型':
      return [
        [
          `${seasonWord}は減りが早いので、先に確保しておくと慌てない`,
          '買い足しに走る回数が減るだけで、週末の使い方が変わる',
          '置き場所さえあれば、切らして困ることはなくなる',
          '毎年この時期に足りなくなるものは、先に決めておきたい',
        ],
        [
          `${seasonWord}に切らすと地味に痛いので、まとめて置いておきたい`,
          '買い出しの予定を気にせず済むぶん、他のことに時間を回せる',
          '同じものを何度も買いに行く手間が消える',
        ],
      ];
    case 'ギフト型':
      return [
        [
          '箱のまま渡せるので、包み直す手間がいらない',
          '渡す相手を選ばない中身なので、手土産に迷う時間が減る',
          '日持ちするぶん、渡すタイミングを気にしなくてよい',
          '当日になって慌てないよう、先に用意しておける',
        ],
        [
          '帰省や集まりの前に、まとめて用意しておくと落ち着く',
          'そのまま持って行ける形なので、直前の準備がいらない',
          '中身が分かれているものは、人数が読めない場面でも扱いやすい',
        ],
      ];
  }
}

/**
 * シーンの後ろに足せる汎用の一文。
 * 角度ごとの文だけでは本文が目標（250〜330字）に届かないことがあるため、
 * 長さの選択肢として持っておく。どの商品でも成り立つ内容にしている。
 */
const SCENE_TAILS = [
  '同じものを何度も買い直すより、置いておけるほうが結局早い',
  '毎日のことなので、ほんの少しの手間の差でも積み上がっていく',
  '使い切れる量かどうかだけ、先に見ておくと失敗しにくい',
];

/**
 * 欠点を装ったポジティブ表現。広告色を薄める効果が高い（実測で食品1位が使用）。
 * 終盤に1つだけ入れる。
 */
const DRAWBACKS = ['難点があるとすれば', '思ったより早くなくなること'];

/* ---------- 第4層 CTA・罫線・ハッシュタグ ---------- */

/** 楽天へ送り出す1行。下向き矢印でタップ先があることを示す */
function ctaTemplates(input: CommentInput): string[] {
  const out: string[] = [];
  if (deadlineLabel(input.priceEndTime) ?? input.couponDeadlineRaw) {
    out.push('セール価格と期限はこちらから確認できます👇');
  }
  out.push('在庫と価格は楽天市場のページで👇');
  out.push('サイズ違い・味違いも同じページにあります👇');
  out.push('詳細とレビューは商品ページにまとまっています👇');
  return out;
}

export const DIVIDER = '─────────────';

/** 自分のコレクションまとめタグ。過去投稿への回遊導線 */
export const COLLECTION_TAG = '#共働き家庭のまとめ買い';

/** ROOM運営の公式イベントタグ。検索流入の導線になる */
const OFFICIAL_TAGS = ['#買ってよかった', '#我が家のお取り寄せ', '#おうち時間充実'];

const ANGLE_TAGS: Record<Angle, string[]> = {
  スーパーにない型: ['#お取り寄せ', '#まとめ買い'],
  評判の裏取り型: ['#リピート決定', '#定番'],
  セール速報型: ['#セール中', '#お得情報'],
  献立負担型: ['#時短ごはん', '#献立に困ったら'],
  ストック切れ回避型: ['#ストックしてる', '#まとめ買い'],
  季節型: ['#季節の買い物', '#旬のもの'],
  ギフト型: ['#手土産', '#ギフト'],
};

/** 悩み・属性系。ターゲット（40〜50代・子どもがいる家庭）の語彙で選ぶ */
const AUDIENCE_TAGS = ['#育ち盛り', '#食べ盛り', '#共働き家庭', '#買い出し'];

function buildHashtags(angle: Angle, input: CommentInput, noun: string, scoring: ScoringConfig): string[] {
  const c = scoring.comment;
  const normalized = noun.replace(/[^\p{Letter}\p{Number}]/gu, '');
  const deadline = deadlineLabel(input.priceEndTime) ?? input.couponDeadlineRaw ?? null;

  const pool = [
    // 自分のコレクションまとめタグは必ず先頭
    COLLECTION_TAG,
    // カテゴリ系
    normalized !== '' ? `#${normalized}` : '#まとめ買い',
    ...ANGLE_TAGS[angle],
    // 公式イベントタグ
    ...OFFICIAL_TAGS,
    // 悩み・属性系
    ...AUDIENCE_TAGS,
    // 期間・価格系（該当時のみ）
    input.discountRate ? `#${input.discountRate}パーセントオフ` : '',
    deadline ? `#${deadline.replace('/', '_')}` : '',
    input.postageFlag === 0 ? '#送料無料' : '',
  ].filter((t) => t !== '');

  const unique: string[] = [];
  for (const tag of pool) {
    if (!unique.includes(tag)) unique.push(tag);
    if (unique.length >= c.hashtagMax) break;
  }
  // 10個に満たない場合の埋め合わせ
  const fillers = ['#お取り寄せグルメ', '#暮らしの記録', '#冷凍ストック', '#買い物メモ'];
  for (const filler of fillers) {
    if (unique.length >= c.hashtagMin) break;
    if (!unique.includes(filler)) unique.push(filler);
  }
  return unique;
}

/* ---------- 組み立て ---------- */

function buildBody(
  angle: Angle,
  input: CommentInput,
  noun: string,
  unit: UnitInfo | null,
  hook: string,
  scoring: ScoringConfig,
  ngWords: NgWordsConfig,
): string[] {
  const c = scoring.comment;
  const clean = (list: string[]) => list.map(dropPeriod).filter((t) => t !== '' && hasBannedWord(t, ngWords) === null);

  const bullets = bulletItems(angle, input, unit)
    .filter((t) => hasBannedWord(t, ngWords) === null)
    .slice(0, c.bulletMax)
    .map((b) => `✅${b}`);

  // 角度ごとの文に汎用の一文を足した版も候補にして、目標の文字数に届く組み合わせを探す
  const baseScenes = sceneTemplates(angle, input, noun).map(clean);
  const scenes: string[][] = [];
  for (const scene of baseScenes) {
    for (let tail = 0; tail <= SCENE_TAILS.length; tail += 1) {
      scenes.push([...scene, ...SCENE_TAILS.slice(0, tail)]);
    }
  }
  const ctas = clean(ctaTemplates(input));
  const hashtags = buildHashtags(angle, input, noun, scoring);

  let best: { lines: string[]; distance: number } | null = null;

  for (const scene of scenes) {
    for (const cta of ctas) {
      // 第1層 → 第2層 → 第3層 → 欠点 → CTA → 罫線
      const lines = [hook, '', ...bullets, '', ...scene, '', ...DRAWBACKS, '', cta, '', DIVIDER];
      // 1行が長すぎるものは折る（上位ほど1行が短い）
      const wrapped = lines.flatMap((l) => (l === '' ? [''] : wrapLine(l, c.lineTarget)));

      const filled = wrapped.filter((l) => l !== '');
      const bodyLength = filled.reduce((sum, l) => sum + charLength(l), 0);
      const overall = bodyLength + hashtags.join(' ').length;

      if (
        filled.length <= c.maxLines &&
        bodyLength >= c.totalMin &&
        bodyLength <= c.totalMax &&
        overall <= c.overallMax
      ) {
        return wrapped;
      }

      const distance =
        bodyLength < c.totalMin ? c.totalMin - bodyLength : bodyLength > c.totalMax ? bodyLength - c.totalMax : 0;
      if (best === null || distance < best.distance) best = { lines: wrapped, distance };
    }
  }
  return best?.lines ?? [hook];
}

export function buildDraftComment(
  angle: Angle,
  input: CommentInput,
  scoring: ScoringConfig,
  ngWords: NgWordsConfig,
): DraftComment {
  const noun = extractNoun(input.itemName, input.genreName);
  const unit = extractUnitPrice(input.itemName, input.itemPrice);
  const hook = buildHook(angle, input, noun, scoring, ngWords);
  const lines = buildBody(angle, input, noun, unit, hook, scoring, ngWords);

  return {
    angle,
    text: lines.join('\n'),
    firstLine: hook,
    firstLineLength: charLength(hook),
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
  const lines = draft.text.split('\n').filter((l) => l.trim() !== '');
  const bodyLength = lines.reduce((sum, line) => sum + charLength(line), 0);
  const overall = bodyLength + draft.hashtags.join(' ').length;

  if (draft.firstLineLength < c.firstLineMin || draft.firstLineLength > c.firstLineMax) {
    violations.push({ rule: 'hookLength', detail: `${draft.firstLineLength}文字（${c.firstLineMin}〜${c.firstLineMax}）` });
  }
  if (bodyLength < c.totalMin || bodyLength > c.totalMax) {
    violations.push({ rule: 'bodyLength', detail: `${bodyLength}文字（${c.totalMin}〜${c.totalMax}）` });
  }
  if (overall > c.overallMax) {
    violations.push({ rule: 'overallLength', detail: `${overall}文字（${c.overallMax}以内）` });
  }
  if (lines.length > c.maxLines) {
    violations.push({ rule: 'maxLines', detail: `${lines.length}行` });
  }
  const longLines = lines.filter((l) => charLength(l) > c.lineMax);
  if (longLines.length > 0) {
    violations.push({ rule: 'lineTooLong', detail: `${longLines.length}行が${c.lineMax}字超` });
  }
  if (draft.hashtags.length < c.hashtagMin || draft.hashtags.length > c.hashtagMax) {
    violations.push({ rule: 'hashtagCount', detail: `${draft.hashtags.length}個` });
  }
  if (new Set(draft.hashtags).size !== draft.hashtags.length) {
    violations.push({ rule: 'hashtagDuplicate', detail: draft.hashtags.join(' ') });
  }
  // 記号付き箇条書きは実測で事実上の必須フォーマット
  const bullets = lines.filter((l) => l.startsWith('✅')).length;
  if (bullets < c.bulletMin) {
    violations.push({ rule: 'bulletCount', detail: `${bullets}行（${c.bulletMin}以上）` });
  }
  // CTAと罫線
  if (!draft.text.includes('👇')) violations.push({ rule: 'ctaMissing', detail: 'CTAが無い' });
  if (!draft.text.includes(DIVIDER)) violations.push({ rule: 'dividerMissing', detail: '罫線が無い' });

  const banned = hasBannedWord(draft.text, ngWords);
  if (banned !== null) violations.push({ rule: 'bannedWord', detail: banned });

  if (startsWithItemName(draft.firstLine, itemName)) {
    violations.push({ rule: 'startsWithItemName', detail: draft.firstLine });
  }
  // 冒頭に割引率を置かない（実測で条件訴求は下位の標準装備）
  if (/\d+\s*[%％]\s*OFF/iu.test(draft.firstLine)) {
    violations.push({ rule: 'hookHasDiscount', detail: draft.firstLine });
  }
  const withPeriod = lines.filter((l) => /[。．]$/u.test(l));
  if (withPeriod.length > 0) {
    violations.push({ rule: 'endsWithPeriod', detail: withPeriod.join(' / ') });
  }
  return violations;
}
