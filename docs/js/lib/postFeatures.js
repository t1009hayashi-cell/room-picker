/**
 * 実際に投稿した文章から、分析に使える特徴を取り出す。
 *
 * **なぜ必要か。**
 * 運用は「商品を選ぶ → AIにURLを投げる → 出てきた文章を直して投稿」で、
 * アプリが生成した投稿文は使っていない。そのためアプリ内の角度タブの値を
 * そのまま投稿ログに記録しても、実際の文章と一致せず分析にならない。
 *
 * 対策は2つ。
 *  1. **人にしか分からないもの（ヘッダー型・選定基準）は投稿時に選んでもらう**
 *  2. **文章から機械的に測れるものは、貼り付けた本文から自動で取る**
 *
 * ここは 2 を担う。投稿プロンプトが実測で挙げている要素
 * （箇条書き・CTA・罫線・1行の文字数・タグ数・オリジナル写真）に揃えている。
 */

import { charLength } from './format.js';
import { headerLine, splitComment } from './commentText.js';

/**
 * 投稿の分類。**ヘッダー型の1軸だけ**（追加要件v1.2 1.1 / 1.2）。
 *
 * 以前は「角度」7分類との2軸だったが、投稿ログ47件を7分類に割ると
 * 1区分あたり数件にしかならず、「投稿数10件未満の区分は数値を出さない」という
 * 既存方針に照らして最初から分析不能だった。角度は廃止し1軸に統合した。
 *
 * **この名称は今後変更しない。** 名称が変わるたびに選択肢と過去データがずれ、
 * 「近いものを選ぶ」運用になって偽のデータが溜まる（47件中27件が空欄になった原因）。
 *
 * 判定は「実際に投稿した1行目が何から始まるか」だけで行う。
 */
export const HEADER_TYPES = [
  '共感課題型', // 読み手の悩み・状況
  'お得条件型', // 割引率・価格・期限
  '称号実績型', // 受賞歴・ランキング・実績
  '商品特徴型', // 容量・加工・スペック
  '判定不可', // どれにも当てはまらない
];

/**
 * 分類方式の世代。
 * v1（角度あり・7分類のヘッダー型）で記録した投稿は名称の対応が取れないため、
 * 遡って付け直さず**分析対象から外す**（追加要件v1.2 1.5）。
 */
export const LABEL_VERSION = 'v2';

/** 「判定不可」も選択済みとして扱う。空欄だけを未選択とする */
export function isLabeled(headerType) {
  return HEADER_TYPES.includes(headerType);
}

/** 選定基準。プロンプトの「ネットで食品を買う動機は3つ」に対応する */
export const CRITERIA = ['スーパーにない', '評価が高い', '今だけ安い'];

/** 箇条書きに使われる記号。プロンプトが挙げているもの */
const BULLET_MARKS = /^[\s]*[✅◇✦❀🟡▶・✔☑◎●▲]/u;

/** 罫線として使われる並び */
const DIVIDER = /^[\s]*[─━＝=\-–—〜~･・.]{5,}[\s]*$/u;

/** CTA（楽天へ送り出す1行）。下向き矢印の絵文字が目印 */
const CTA_MARK = /[👇⬇️⤵️]/u;

const EMOJI = /[\p{Extended_Pictographic}]/u;

/**
 * 本文から特徴を取り出す。
 * `text` はハッシュタグ行を含む、実際に投稿したテキストそのもの。
 */
export function extractPostFeatures(text) {
  const { body, hashtags } = splitComment(text);
  const lines = body === '' ? [] : body.split('\n');
  // 空行は「行数」に数えない。改行の細かさを見たいので中身のある行だけを対象にする
  const filled = lines.filter((l) => l.trim() !== '');

  const lineLengths = filled.map((l) => charLength(l));
  const totalLength = lineLengths.reduce((sum, n) => sum + n, 0);
  const bulletLines = filled.filter((l) => BULLET_MARKS.test(l)).length;
  // 1.4: 先頭の空行やタグ行を拾わないよう、本文の最初の中身のある行を使う
  const header = headerLine(text);

  return {
    /** ヘッダー（1行目）の文字数。フィードで見えるのはここだけ */
    headerLength: charLength(header),
    headerText: header,
    /** ハッシュタグを除いた本文の文字数 */
    bodyLength: totalLength,
    /** ハッシュタグ込みの全体。ROOMの上限500文字はこちらで見る */
    totalLength: totalLength + hashtags.join(' ').length,
    lineCount: filled.length,
    /** 1行あたりの平均文字数。上位ほど短い（実測で1〜10位は21文字） */
    averageLineLength: filled.length === 0 ? 0 : Math.round(totalLength / filled.length),
    maxLineLength: lineLengths.length === 0 ? 0 : Math.max(...lineLengths),
    hashtagCount: hashtags.length,
    hashtags,
    /** 記号付き箇条書きの行数。実測で40件中38件が使用 */
    bulletLines,
    hasBullets: bulletLines > 0,
    /** 楽天へ送り出すCTAがあるか */
    hasCta: CTA_MARK.test(body),
    /** 罫線で区切っているか */
    hasDivider: filled.some((l) => DIVIDER.test(l)),
    hasEmoji: EMOJI.test(body),
    /** 自分で撮影した写真を使ったか。ランク条件かつ上位表示の要因とされている */
    hasOriginalPhotoTag: hashtags.some((t) => t.includes('オリジナル写真')),
    /** 割引率・価格・容量などの数字を含むか */
    hasNumber: /\d/.test(body),
  };
}

/** ヘッダーの文字数帯。プロンプトの推奨は20〜30文字 */
export function headerBand(length) {
  if (length <= 19) return '〜19';
  if (length <= 30) return '20〜30';
  return '31〜';
}

/** 本文全体の文字数帯。ROOMの上限は500文字、実測の上位平均は322文字 */
export function totalLengthBand(length) {
  if (length <= 250) return '〜250';
  if (length <= 350) return '251〜350';
  if (length <= 480) return '351〜480';
  return '481〜（上限超え）';
}

/** 1行あたりの平均文字数帯。実測は1〜10位が21文字、31〜50位が29文字 */
export function lineLengthBand(average) {
  if (average <= 0) return '不明';
  if (average <= 24) return '〜24（細かい）';
  if (average <= 29) return '25〜29';
  return '30〜（粗い）';
}
