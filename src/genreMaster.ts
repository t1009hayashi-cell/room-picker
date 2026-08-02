/**
 * ジャンルマスタの組み立て。
 *
 * 設定画面で「対象ジャンル」を名前だけで選べるようにするための一覧を作る。
 * これが無いと、ユーザーが genreId を自分で調べて手入力する必要がある。
 *
 * 楽天のジャンルツリーは全部で数万件あり、1リクエスト1秒以上のsleepが必須（仕様書4.3）なので
 * 全階層を辿ると現実的な時間で終わらない。既定は第2階層までとし、
 * リクエスト数を「1 + 第1階層の件数」に抑える（実測でおよそ40件＝1分弱）。
 */

import type { GenreNode, GenreSearchResult } from './rakuten/client.js';

/** ジャンルツリーのルート。楽天のジャンル検索APIはこれを起点に子を返す */
export const GENRE_ROOT_ID = '0';

export interface GenreMasterEntry {
  genreId: string;
  genreName: string;
  level: number;
  /** 第1階層のジャンルなら null */
  parentId: string | null;
  parentName: string | null;
  /** 「食品 > コーヒー」のような表示用の並び。同名ジャンルの区別に使う */
  path: string;
}

export interface GenreMasterFile {
  updatedAt: string;
  /** 何階層目まで取得したか。増やしたときに古いファイルと区別できるようにする */
  maxLevel: number;
  genres: GenreMasterEntry[];
}

export interface BuildGenreMasterOptions {
  /** 取得する深さ。1 なら第1階層のみ、2 なら子まで */
  maxLevel?: number;
  onLog?: (message: string) => void;
  /** 1件でも失敗したら全体を捨てるのではなく、取れた分を残す */
  onWarn?: (message: string) => void;
}

export type GenreFetch = (genreId: string) => Promise<GenreSearchResult>;

/**
 * ルートから順に子を辿って、フラットな一覧を作る。
 * 途中のジャンルで失敗しても、そのジャンルの子を諦めるだけで全体は続行する。
 */
export async function buildGenreMaster(
  fetchGenre: GenreFetch,
  options: BuildGenreMasterOptions = {},
): Promise<GenreMasterEntry[]> {
  const maxLevel = Math.max(1, options.maxLevel ?? 2);
  const log = options.onLog ?? (() => {});
  const warn = options.onWarn ?? (() => {});

  const entries: GenreMasterEntry[] = [];
  const seen = new Set<string>();

  const root = await fetchGenre(GENRE_ROOT_ID);
  const topLevel = root.children;
  log(`第1階層: ${topLevel.length}件`);

  for (const node of topLevel) {
    push(entries, seen, node, null, null);
  }

  if (maxLevel >= 2) {
    for (const [i, parent] of topLevel.entries()) {
      let result: GenreSearchResult;
      try {
        result = await fetchGenre(parent.genreId);
      } catch (err) {
        warn(`${parent.genreName}(${parent.genreId}) の子ジャンルを取得できませんでした: ${(err as Error).message}`);
        continue;
      }
      log(`  [${i + 1}/${topLevel.length}] ${parent.genreName}: 子${result.children.length}件`);
      for (const child of result.children) {
        push(entries, seen, child, parent.genreId, parent.genreName);
      }
    }
  }

  // 名前順に並べておくと、設定画面で前方一致検索したときの並びが安定する
  entries.sort((a, b) => a.path.localeCompare(b.path, 'ja'));
  return entries;
}

function push(
  entries: GenreMasterEntry[],
  seen: Set<string>,
  node: GenreNode,
  parentId: string | null,
  parentName: string | null,
): void {
  // 同じジャンルが複数の親にぶら下がることがある。先に見つけた側を残す
  if (seen.has(node.genreId)) return;
  seen.add(node.genreId);
  entries.push({
    genreId: node.genreId,
    genreName: node.genreName,
    level: node.level,
    parentId,
    parentName,
    path: parentName ? `${parentName} > ${node.genreName}` : node.genreName,
  });
}
