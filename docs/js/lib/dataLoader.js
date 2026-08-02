/**
 * data/*.json の読み込み。
 * ブラウザからは同一オリジンの静的JSONを読むだけ（楽天APIを直接叩かない＝CORSが発生しない）。
 */

const memory = new Map();
let indexPromise = null;
let salesPromise = null;
let genreMasterPromise = null;

async function getJson(path) {
  if (memory.has(path)) return memory.get(path);
  const promise = fetch(path, { cache: 'no-cache' }).then(async (res) => {
    if (!res.ok) throw new Error(`${path} の取得に失敗しました (${res.status})`);
    return res.json();
  });
  memory.set(path, promise);
  try {
    return await promise;
  } catch (err) {
    memory.delete(path);
    throw err;
  }
}

export function loadIndex() {
  if (!indexPromise) {
    indexPromise = getJson('./data/index.json').catch((err) => {
      indexPromise = null;
      throw err;
    });
  }
  return indexPromise;
}

export function loadSales() {
  if (!salesPromise) {
    salesPromise = getJson('./data/sales.json').catch(() => {
      // 一時的な失敗をセッション中固定しないよう、フォールバック値はキャッシュしない
      salesPromise = null;
      return { updatedAt: null, sales: [] };
    });
  }
  return salesPromise;
}

/**
 * ジャンルマスタ（設定画面でジャンルを名前で選ぶための一覧）。
 * genre-master ワークフローが未実行のうちは存在しないので、
 * 失敗しても画面を止めず空で返し、呼び出し側が手入力に切り替えられるようにする。
 */
export function loadGenreMaster() {
  if (!genreMasterPromise) {
    genreMasterPromise = getJson('./data/genre-master.json').catch(() => {
      genreMasterPromise = null;
      return { updatedAt: null, maxLevel: 0, genres: [] };
    });
  }
  return genreMasterPromise;
}

export function loadSnapshot(dateKey) {
  return getJson(`./data/${dateKey}.json`);
}

/** 同時実行数を絞って複数日を読み込む。失敗した日は無視して残りを返す */
export async function loadSnapshots(dateKeys, concurrency = 4) {
  const out = new Map();
  const queue = [...dateKeys];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const key = queue.shift();
      try {
        out.set(key, await loadSnapshot(key));
      } catch (err) {
        console.warn(`${key} の読み込みに失敗しました`, err);
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/** スナップショットを (item, genre) のフラットな配列に展開する */
export function flattenSnapshot(snapshot) {
  const out = [];
  if (!snapshot?.genres) return out;
  for (const genre of snapshot.genres) {
    for (const item of genre.items) {
      out.push({
        ...item,
        genreId: genre.genreId,
        genreName: genre.genreName,
        genreCommissionRate: genre.commissionRate,
        discoveredDate: snapshot.date,
      });
    }
  }
  return out;
}

export function resetCache() {
  memory.clear();
  indexPromise = null;
  salesPromise = null;
  genreMasterPromise = null;
}
