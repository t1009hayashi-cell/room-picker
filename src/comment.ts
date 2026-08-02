import type { DraftComment, NgWordsConfig, ScoringConfig } from './types.js';
import { containsAny } from './filter.js';

/**
 * 仕様書 9.1 の投稿文テンプレート生成。
 *
 * 生成ルール
 *  - 1行目は 30〜35 文字。ROOMのフィードではここしか表示されない
 *  - 1行目は問いかけ／ターゲット指定／ベネフィットの名詞句のいずれか
 *  - 商品名やブランド名から書き始めない
 *  - 全体 80〜150 文字、1文ごとに改行、3行以内（改行文字は文字数に数えない）
 *  - 末尾にハッシュタグ3〜4個
 *  - 商品名に含まれる「最安値」「楽天1位」「半額」等を投稿文に転記しない
 *  - 実際には使用していないため、使用体験を装わない
 */

export const ANGLES = ['手間削減', 'ストック切れ回避', 'コスパ比較', '季節'] as const;
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

const SEASON_WORDS: Record<'spring' | 'summer' | 'autumn' | 'winter', string[]> = {
  spring: ['新生活', '入学', '花見', '母の日', '春'],
  summer: ['麦茶', '炭酸水', '冷', 'アイス', 'そうめん', 'スポーツドリンク', 'ゼリー', '夏'],
  autumn: ['栗', 'さつまいも', 'ハロウィン', '秋', '新米'],
  winter: ['ホット', '鍋', '福袋', 'あったか', 'ココア', 'おでん', '冬'],
};

const SEASON_LEAD: Record<'spring' | 'summer' | 'autumn' | 'winter', string> = {
  spring: '新生活の時期',
  summer: '暑い時期',
  autumn: '肌寒くなる時期',
  winter: '寒い時期',
};

const BULK_WORDS = ['まとめ買い', 'ケース', '箱', '大容量', '業務用', '詰め替え', '詰替', 'セット', '×', 'ラベルレス'];
const STOCK_WORDS = ['まとめ買い', 'ケース', '箱', '業務用', '大容量', 'ストック', '常備', '長期保存', '入', 'セット'];

/** 数量の単位。1本あたり／1袋あたりの単価算出に使う */
const UNIT_PATTERN = /(\d+(?:\.\d+)?)\s*(本|袋|個|缶|杯|パック|枚|包|食|箱|セット)/g;

export function seasonOf(month: number): 'spring' | 'summer' | 'autumn' | 'winter' {
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

/** 商品名からカテゴリ語を取り出す。見つからなければジャンル名の先頭セグメントを使う */
export function extractNoun(itemName: string, genreName: string): string {
  for (const word of CATEGORY_WORDS) {
    if (matchesAsWord(itemName, word)) return word;
  }
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

export function scoreAngles(input: CommentInput, unit: UnitInfo | null): Array<{ angle: Angle; score: number }> {
  const name = input.itemName;
  const season = seasonOf(input.month);

  const bulk = BULK_WORDS.filter((w) => name.includes(w)).length;
  const stock = STOCK_WORDS.filter((w) => name.includes(w)).length;
  const seasonHits = SEASON_WORDS[season].filter((w) => name.includes(w)).length;

  return [
    { angle: '手間削減' as Angle, score: bulk * 2 + (input.postageFlag === 0 ? 1 : 0) },
    { angle: 'ストック切れ回避' as Angle, score: stock * 2 },
    { angle: 'コスパ比較' as Angle, score: unit ? 3 + Math.min(unit.count / 12, 3) : 0 },
    { angle: '季節' as Angle, score: seasonHits * 3 },
  ];
}

/** 同点時の優先順位。仕様書に定めが無いため、汎用性の高い順に固定する */
const ANGLE_PRIORITY: Angle[] = ['ストック切れ回避', '手間削減', 'コスパ比較', '季節'];

export function selectAngles(input: CommentInput, unit: UnitInfo | null): Angle[] {
  const scored = scoreAngles(input, unit);
  const byAngle = new Map(scored.map((s) => [s.angle, s.score]));

  const ordered = [...ANGLE_PRIORITY].sort((a, b) => {
    const diff = (byAngle.get(b) ?? 0) - (byAngle.get(a) ?? 0);
    if (diff !== 0) return diff;
    return ANGLE_PRIORITY.indexOf(a) - ANGLE_PRIORITY.indexOf(b);
  });

  // コスパ比較は単価を出せないと成立しないため候補から外す
  const usable = ordered.filter((angle) => angle !== 'コスパ比較' || unit !== null);
  return usable.slice(0, 2);
}

/** 1行目の長さ調整に使う導入句。ターゲット指定・問いかけの形を崩さない範囲で並べる */
const LEAD_INS = ['', 'そろそろ、', '忙しい人ほど、', '毎日のことだから、', '共働き世帯にこそ、', '平日をラクにしたい人へ。'];

function firstLineTemplates(angle: Angle, noun: string, unit: UnitInfo | null, season: keyof typeof SEASON_LEAD): string[] {
  switch (angle) {
    case '手間削減':
      return [
        `${noun}を買いに行く回数、減らしませんか`,
        `${noun}の買い足し、毎週やっていませんか`,
        `重い${noun}を運ぶ手間、手放しませんか`,
        `買い物リストから${noun}を消す方法`,
        `${noun}の買い出しに使う時間、取り戻しませんか`,
      ];
    case 'ストック切れ回避':
      return [
        `${noun}を切らしてから慌てていませんか`,
        `${noun}のストック、足りていますか`,
        `${noun}が無いことに気づくのは、いつも夜`,
        `${noun}を買い忘れて困った経験、ありませんか`,
        `${noun}のストックがあるだけで、平日が軽くなる`,
      ];
    case 'コスパ比較':
      return [
        `1${unit?.unit ?? '本'}あたりで考えたことはありますか`,
        `${noun}の単価、計算したことはありますか`,
        `${noun}は1${unit?.unit ?? '本'}あたりで比べると景色が変わる`,
        `まとめると1${unit?.unit ?? '本'}あたりはここまで下がる`,
      ];
    case '季節':
      return [
        `${SEASON_LEAD[season]}の${noun}、足りていますか`,
        `${SEASON_LEAD[season]}は${noun}の減りが早い`,
        `${SEASON_LEAD[season]}に向けて${noun}の準備はお済みですか`,
        `${SEASON_LEAD[season]}こそ${noun}をまとめておきたい`,
      ];
  }
}

function bodyTemplates(angle: Angle, noun: string, unit: UnitInfo | null, season: keyof typeof SEASON_LEAD): string[] {
  switch (angle) {
    case '手間削減':
      return [
        'まとめて届くので、買い出しの回数がそのまま減ります。',
        '一度頼んでおけば、しばらく買い足しを考えずに済みます。',
        '運ぶ・選ぶ・並ぶ、その全部を省けるのがまとめ買いです。',
      ];
    case 'ストック切れ回避':
      return [
        '切らしてから買いに走る、あの慌ただしさが無くなります。',
        `${noun}のストックがあるだけで、平日の余裕がひとつ増えます。`,
        '「無い」と気づく前に補充しておける状態を作れます。',
      ];
    case 'コスパ比較':
      return unit
        ? [
            `1${unit.unit}あたり約${unit.unitPrice}円。まとめるほど単価は下がります。`,
            `${unit.count}${unit.unit}で割ると1${unit.unit}約${unit.unitPrice}円。数字で比べると分かりやすいです。`,
          ]
        : ['まとめて買うほど、1回あたりの負担は軽くなります。'];
    case '季節':
      return [
        `${SEASON_LEAD[season]}は減りが早いので、多めに用意しておくと安心です。`,
        `${SEASON_LEAD[season]}に買い足しに走らずに済む量を、先に確保しておく手もあります。`,
      ];
  }
}

function closingTemplates(input: CommentInput): string[] {
  const out: string[] = [];
  if (input.reviewCount > 0 && input.reviewAverage > 0) {
    out.push(`レビューは${input.reviewCount.toLocaleString('en-US')}件、平均${input.reviewAverage.toFixed(2)}です。`);
  }
  if (input.postageFlag === 0) {
    out.push('送料込みの価格なので、比較するときも計算がしやすいです。');
  }
  if (input.pointRate >= 5) {
    out.push(`ポイント${input.pointRate}倍の期間に合わせると、実質の負担が変わります。`);
  }
  out.push('気になったら、条件を見てから決めてみてください。');
  out.push('買い物の回数を減らしたい人は、一度覗いてみてください。');
  return out;
}

function charLength(text: string): number {
  return Array.from(text).length;
}

/** 商品名の書き出しをそのまま流用していないか（仕様書 9.1「商品名やブランド名から書き始めない」） */
function startsWithItemName(line: string, itemName: string): boolean {
  const head = Array.from(itemName.trim()).slice(0, 4).join('');
  return head.length >= 2 && line.startsWith(head);
}

export function hasBannedWord(text: string, ngWords: NgWordsConfig): string | null {
  return containsAny(text, ngWords.commentBanned) ?? containsAny(text, ngWords.health);
}

function buildFirstLine(
  angle: Angle,
  input: CommentInput,
  noun: string,
  unit: UnitInfo | null,
  scoring: ScoringConfig,
  ngWords: NgWordsConfig,
): string {
  const { firstLineMin, firstLineMax } = scoring.comment;
  const season = seasonOf(input.month);
  const templates = firstLineTemplates(angle, noun, unit, season);

  const candidates: string[] = [];
  for (const lead of LEAD_INS) {
    for (const template of templates) {
      const suffixes = template.endsWith('か') ? ['？'] : ['。', 'という話です。'];
      for (const suffix of suffixes) candidates.push(`${lead}${template}${suffix}`);
    }
  }

  const valid = candidates.filter((c) => !startsWithItemName(c, input.itemName) && hasBannedWord(c, ngWords) === null);
  const inRange = valid.filter((c) => {
    const len = charLength(c);
    return len >= firstLineMin && len <= firstLineMax;
  });

  if (inRange.length > 0) {
    // カテゴリ語が商品名から取られている場合、その語で書き出すと商品名の書き出しに近づく。
    // 仕様書9.1の「商品名から書き始めない」に寄せるため、導入句がある候補を優先する。
    const nounFromItemName = input.itemName.includes(noun);
    const rank = (line: string) => (nounFromItemName && line.startsWith(noun) ? 1 : 0);
    // 範囲内なら中央値に最も近いものを選ぶ（決定的）
    const mid = (firstLineMin + firstLineMax) / 2;
    return inRange.sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      const d = Math.abs(charLength(a) - mid) - Math.abs(charLength(b) - mid);
      return d !== 0 ? d : a.localeCompare(b);
    })[0]!;
  }

  // 範囲に収まる候補が無い場合は上限で切る。フィードで切れるより短い方が害が小さい
  const fallback = valid.length > 0 ? valid : candidates;
  const closest = fallback.sort((a, b) => {
    const da = Math.min(Math.abs(charLength(a) - firstLineMin), Math.abs(charLength(a) - firstLineMax));
    const db = Math.min(Math.abs(charLength(b) - firstLineMin), Math.abs(charLength(b) - firstLineMax));
    return da !== db ? da - db : a.localeCompare(b);
  })[0]!;
  return Array.from(closest).slice(0, firstLineMax).join('');
}

function buildHashtags(angle: Angle, input: CommentInput, noun: string, scoring: ScoringConfig): string[] {
  const normalized = noun.replace(/[^\p{Letter}\p{Number}]/gu, '');
  const angleTag: Record<Angle, string> = {
    手間削減: '#時短',
    ストック切れ回避: '#ストック管理',
    コスパ比較: '#コスパ重視',
    季節: `#${SEASON_LEAD[seasonOf(input.month)].replace(/[^\p{Letter}\p{Number}]/gu, '')}`,
  };

  const pool = [
    normalized !== '' ? `#${normalized}` : '#まとめ買い',
    '#まとめ買い',
    angleTag[angle],
    '#共働き',
    input.postageFlag === 0 ? '#送料込み' : '#買い物メモ',
  ];

  const unique: string[] = [];
  for (const tag of pool) {
    if (!unique.includes(tag)) unique.push(tag);
    if (unique.length >= scoring.comment.hashtagMax) break;
  }
  while (unique.length < scoring.comment.hashtagMin) unique.push('#暮らしの記録');
  return unique;
}

function buildBody(
  angle: Angle,
  input: CommentInput,
  noun: string,
  unit: UnitInfo | null,
  firstLine: string,
  scoring: ScoringConfig,
  ngWords: NgWordsConfig,
): string[] {
  const { totalMin, totalMax, maxLines } = scoring.comment;
  const season = seasonOf(input.month);
  const seconds = bodyTemplates(angle, noun, unit, season).filter((t) => hasBannedWord(t, ngWords) === null);
  const thirds = [...closingTemplates(input).filter((t) => hasBannedWord(t, ngWords) === null), ''];

  const firstLen = charLength(firstLine);
  let best: { lines: string[]; distance: number } | null = null;

  for (const second of seconds) {
    for (const third of thirds) {
      const lines = third === '' ? [firstLine, second] : [firstLine, second, third];
      if (lines.length > maxLines) continue;
      const total = firstLen + charLength(second) + charLength(third);
      if (total >= totalMin && total <= totalMax) return lines;

      const distance = total < totalMin ? totalMin - total : total - totalMax;
      if (best === null || distance < best.distance) best = { lines, distance };
    }
  }
  return best?.lines ?? [firstLine];
}

export function buildDraftComment(
  angle: Angle,
  input: CommentInput,
  scoring: ScoringConfig,
  ngWords: NgWordsConfig,
): DraftComment {
  const noun = extractNoun(input.itemName, input.genreName);
  const unit = extractUnitPrice(input.itemName, input.itemPrice);
  const firstLine = buildFirstLine(angle, input, noun, unit, scoring, ngWords);
  const lines = buildBody(angle, input, noun, unit, firstLine, scoring, ngWords);

  return {
    angle,
    text: lines.join('\n'),
    firstLine,
    firstLineLength: charLength(firstLine),
    hashtags: buildHashtags(angle, input, noun, scoring),
  };
}

/** 仕様書 9.1: 角度は4種のうち商品に合うものを2つ選ぶ */
export function buildDraftComments(
  input: CommentInput,
  scoring: ScoringConfig,
  ngWords: NgWordsConfig,
): DraftComment[] {
  const unit = extractUnitPrice(input.itemName, input.itemPrice);
  return selectAngles(input, unit).map((angle) => buildDraftComment(angle, input, scoring, ngWords));
}

export interface CommentViolation {
  rule: string;
  detail: string;
}

/** テストと開発時の自己点検用。生成物が 9.1 のルールを満たしているか検査する */
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
    violations.push({ rule: 'firstLineLength', detail: `${draft.firstLineLength}文字（${c.firstLineMin}〜${c.firstLineMax}）` });
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
  const banned = hasBannedWord(draft.text, ngWords);
  if (banned !== null) {
    violations.push({ rule: 'bannedWord', detail: banned });
  }
  if (startsWithItemName(draft.firstLine, itemName)) {
    violations.push({ rule: 'startsWithItemName', detail: draft.firstLine });
  }
  return violations;
}
