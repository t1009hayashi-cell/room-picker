/**
 * 投稿文テキストの編集補助。
 * 投稿ログ（仕様書 5.4）は commentBody と hashtags を分けて保存するため、
 * 編集欄の1つのテキストから両者を復元できるようにする。
 */

import { charLength } from './format.js';

/** 末尾のハッシュタグ行を本文から切り離す */
export function splitComment(text) {
  const lines = String(text ?? '').split('\n');
  const last = lines[lines.length - 1]?.trim() ?? '';
  if (lines.length > 1 && last.startsWith('#')) {
    return {
      body: lines.slice(0, -1).join('\n').trimEnd(),
      hashtags: last.split(/[\s　]+/).filter((tag) => tag.startsWith('#')),
    };
  }
  return { body: String(text ?? '').trim(), hashtags: [] };
}

export function joinComment(body, hashtags) {
  return hashtags?.length ? `${body}\n${hashtags.join(' ')}` : body;
}

/**
 * 投稿文の推奨値。投稿プロンプト（`新規 テキスト ドキュメント (2).txt`）の型に合わせている。
 * バッチ側は config/scoring.json の comment を使う。**両者は同じ値にすること。**
 */
export const COMMENT_RULES = {
  headerMin: 16,
  headerMax: 24,
  totalMin: 120,
  totalMax: 180,
  maxLines: 6,
  hashtagMin: 3,
  hashtagMax: 6,
};

/** 編集中の投稿文が推奨の型に収まっているかを測る */
export function measureComment(text) {
  const { body, hashtags } = splitComment(text);
  const lines = body === '' ? [] : body.split('\n');
  const firstLineLength = charLength(lines[0] ?? '');
  const totalLength = lines.reduce((sum, line) => sum + charLength(line), 0);
  const r = COMMENT_RULES;
  return {
    firstLineLength,
    totalLength,
    lineCount: lines.length,
    hashtagCount: hashtags.length,
    // プロンプトが必須としている2点。守れていないと編集欄に警告が出る
    headerHasNumber: /\d/.test(lines[0] ?? ''),
    endsWithPeriod: lines.some((l) => /[。．]$/u.test(l)),
    withinRules:
      firstLineLength >= r.headerMin &&
      firstLineLength <= r.headerMax &&
      totalLength >= r.totalMin &&
      totalLength <= r.totalMax &&
      lines.length <= r.maxLines &&
      hashtags.length >= r.hashtagMin &&
      hashtags.length <= r.hashtagMax &&
      /\d/.test(lines[0] ?? '') &&
      !lines.some((l) => /[。．]$/u.test(l)),
  };
}
