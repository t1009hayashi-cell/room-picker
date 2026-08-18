/**
 * 投稿文テキストの編集補助。
 * 投稿ログ（仕様書 5.4）は commentBody と hashtags を分けて保存するため、
 * 編集欄の1つのテキストから両者を復元できるようにする。
 */

import { charLength } from './format.js';

/** その行がハッシュタグだけで構成されているか */
function isHashtagLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('#')) return false;
  return trimmed.split(/[\s　]+/).every((token) => token.startsWith('#'));
}

function tagsOf(line) {
  return line.trim().split(/[\s　]+/).filter((tag) => tag.startsWith('#'));
}

/**
 * ハッシュタグ行を本文から切り離す。
 *
 * 末尾に置くのが基本だが、投稿プロンプトは「ハッシュタグを1行目に置く形式も上位に見られる」
 * として先頭に置く形も認めている。先頭に置いた投稿でタグ0個と数えてしまうと、
 * 編集欄に常に警告が出て、投稿ログのハッシュタグも空で保存されてしまう。
 *
 * **タグ行は複数行にまたがる。** プロンプトの出力例は10〜12個のタグを4〜5行に分けて置く。
 * 1行だけ切り離す実装だと残りが本文に混ざり、タグ数も過少に記録される
 * （追加要件v1.2 4.3 で「タグ数0の行がある」として報告された不具合）。
 * 連続するタグ行はまとめて切り離す。
 */
export function splitComment(text) {
  const raw = String(text ?? '');
  const lines = raw.split('\n');
  if (lines.length > 1) {
    // 末尾から、タグだけの行が続くかぎりさかのぼる。
    // 途中の空行はタグ群の一部とみなす（タグ行の間に空行を挟む書き方があるため）
    let end = lines.length;
    let firstTag = end;
    for (let i = end - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (isHashtagLine(line)) {
        firstTag = i;
        continue;
      }
      // 空行はタグ群の一部として読み飛ばす（末尾の余分な改行や、タグ行の間の空行）
      if (line.trim() === '') continue;
      break;
    }
    if (firstTag < end) {
      return {
        body: lines.slice(0, firstTag).join('\n').trimEnd(),
        hashtags: lines.slice(firstTag).flatMap(tagsOf),
      };
    }

    // 先頭に置く形。こちらも複数行にまたがることがある
    let lastTag = -1;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (isHashtagLine(line)) {
        lastTag = i;
        continue;
      }
      // 先頭の空行もタグを探す前に読み飛ばす
      if (line.trim() === '') continue;
      break;
    }
    if (lastTag >= 0) {
      return {
        body: lines.slice(lastTag + 1).join('\n').trim(),
        hashtags: lines.slice(0, lastTag + 1).flatMap(tagsOf),
      };
    }
  }
  return { body: raw.trim(), hashtags: [] };
}

/**
 * 投稿の「ヘッダー」＝本文の最初の1行。
 *
 * 追加要件v1.2 1.4。`body.split('\n')[0]` だと先頭の空行や、
 * 先頭に置いたタグ行をヘッダーとして保存してしまう。
 * タグを除いた本文の、**最初の中身のある行**だけを返す。
 */
export function headerLine(text) {
  const { body } = splitComment(text);
  return body.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}

export function joinComment(body, hashtags) {
  return hashtags?.length ? `${body}\n${hashtags.join(' ')}` : body;
}

/**
 * 投稿文の推奨値。投稿プロンプト（`新規 テキスト ドキュメント (2).txt`）の型に合わせている。
 * バッチ側は config/scoring.json の comment を使う。**両者は同じ値にすること。**
 */
export const COMMENT_RULES = {
  // 投稿プロンプト（プロンプト/room_post_prompt_final.md）の実測値に合わせている
  headerMin: 20,
  headerMax: 30,
  /** ハッシュタグを除いた本文 */
  totalMin: 250,
  totalMax: 330,
  /** ROOMの上限は500文字。タグ込みで480文字以内に収める */
  overallMax: 480,
  maxLines: 24,
  /** 1行の文字数。上位ほど短い（実測で1〜10位は21文字） */
  lineMax: 30,
  hashtagMin: 10,
  hashtagMax: 15,
};

/** 編集中の投稿文が推奨の型に収まっているかを測る */
export function measureComment(text) {
  const { body, hashtags } = splitComment(text);
  const lines = body === '' ? [] : body.split('\n');
  const firstLineLength = charLength(lines.find((l) => l.trim() !== '') ?? '');
  const totalLength = lines.reduce((sum, line) => sum + charLength(line), 0);
  const r = COMMENT_RULES;
  const filled = lines.filter((l) => l.trim() !== '');
  const overallLength = totalLength + hashtags.join(' ').length;
  const longLines = filled.filter((l) => charLength(l) > r.lineMax).length;
  const endsWithPeriod = filled.some((l) => /[。．]$/u.test(l));

  return {
    firstLineLength,
    totalLength,
    overallLength,
    lineCount: filled.length,
    hashtagCount: hashtags.length,
    longLines,
    endsWithPeriod,
    withinRules:
      firstLineLength >= r.headerMin &&
      firstLineLength <= r.headerMax &&
      totalLength >= r.totalMin &&
      totalLength <= r.totalMax &&
      overallLength <= r.overallMax &&
      filled.length <= r.maxLines &&
      longLines === 0 &&
      hashtags.length >= r.hashtagMin &&
      hashtags.length <= r.hashtagMax &&
      !endsWithPeriod,
  };
}
