/**
 * 設定画面のジャンル検索。
 *
 * ジャンルマスタ（data/genre-master.json、genre-master ワークフローが生成）から
 * 名前で候補を絞り込む。これにより genreId を自分で調べて手入力する必要がなくなる。
 */

/**
 * 入力文字列でジャンルを絞り込む。
 * ジャンル名・「親 > 子」のパス・genreId のいずれかに含まれれば該当とする。
 * genreId も対象にしているのは、番号がわかっている場合の逃げ道を残すため。
 */
export function searchGenres(entries, query, limit = 20) {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  // 空で全件返すと数百件を描画してしまうので何も返さない
  if (!q) return [];

  const hits = (entries ?? []).filter(
    (e) =>
      e.genreName.toLowerCase().includes(q) || e.path.toLowerCase().includes(q) || String(e.genreId) === q,
  );

  // 完全一致 > 前方一致 > 名前に含む > パスにだけ含む の順に出す
  const score = (e) => {
    const name = e.genreName.toLowerCase();
    if (String(e.genreId) === q || name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (name.includes(q)) return 2;
    return 3;
  };
  return hits.sort((a, b) => score(a) - score(b) || a.path.localeCompare(b.path, 'ja')).slice(0, limit);
}

/**
 * 楽天アフィリエイトの料率はジャンル検索APIから取得できないため、既定値を当てる。
 * 実際の料率は API が商品ごとに返す affiliateRate が優先される（仕様書 4.4）。
 * ここでの値は、API が料率を返さなかったときのフォールバックにしかならない。
 */
export const DEFAULT_COMMISSION_RATE = 0.04;
