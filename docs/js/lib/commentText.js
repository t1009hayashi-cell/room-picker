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

/** 編集中の投稿文が仕様書 9.1 の生成ルールに収まっているかを測る */
export function measureComment(text) {
  const { body, hashtags } = splitComment(text);
  const lines = body === '' ? [] : body.split('\n');
  const firstLineLength = charLength(lines[0] ?? '');
  const totalLength = lines.reduce((sum, line) => sum + charLength(line), 0);
  return {
    firstLineLength,
    totalLength,
    lineCount: lines.length,
    hashtagCount: hashtags.length,
    withinRules:
      firstLineLength >= 30 &&
      firstLineLength <= 35 &&
      totalLength >= 80 &&
      totalLength <= 150 &&
      lines.length <= 3 &&
      hashtags.length >= 3 &&
      hashtags.length <= 4,
  };
}
