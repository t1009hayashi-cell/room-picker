/*
 * Service Worker。
 * アプリシェルはキャッシュ優先、data/*.json はネットワーク優先＋失敗時キャッシュとする。
 * 日次JSONは日付ごとに新規ファイルなので、一度取得したものは書き換わらない前提でよい。
 * ただし当日分は Actions の再実行で更新されうるため、常にネットワークを先に試す。
 */
// アプリシェルとデータで世代を分ける。
// コードを直したときは SHELL_VERSION だけ上げれば、
// オフライン用に貯めた日次JSONを捨てずに端末へ更新を届けられる。
// v2: 長押しメニュー抑止とレイアウト修正（2026-08-02）
// v3: ジャンル名検索・絞り込み追加・並び順・URLコピー（2026-08-03）
// v4: 予約投稿・投稿文コピー・表示の絞り込み（2026-08-03）
// v5: 予約/投稿済みを日付ごとに記録・AI用プロンプト廃止（2026-08-03）
// v6: ジャンルの未反映を明示・反映手順の導線（2026-08-04）
// v7: ジャンル別表示・商品名コピー・投稿文をプロンプトの型に（2026-08-04）
// v8: ボタン配置の整列・警告のはみ出し修正・商品名を検索用に短縮（2026-08-04）
// v9: 追加要件v1.1（reviewAverage判定・クーポン抽出・dealScore・レビューURL）（2026-08-04）
const SHELL_VERSION = 'v9';
const DATA_VERSION = 'v1';
const SHELL_CACHE = `room-shell-${SHELL_VERSION}`;
const DATA_CACHE = `room-data-${DATA_VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/main.js',
  './js/lib/store.js',
  './js/lib/dataLoader.js',
  './js/lib/format.js',
  './js/lib/schedule.js',
  './js/lib/filters.js',
  './js/lib/genres.js',
  './js/lib/itemName.js',
  './js/lib/catalog.js',
  './js/lib/commentText.js',
  './js/lib/prompt.js',
  './js/lib/csv.js',
  './js/lib/match.js',
  './js/lib/aggregate.js',
  './js/views/calendar.js',
  './js/views/dayList.js',
  './js/views/analytics.js',
  './js/views/settings.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.includes('/data/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(DATA_CACHE).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached ?? Response.error())),
    );
    return;
  }

  // アプリシェルは stale-while-revalidate。
  // cache-first にすると、コードを直しても VERSION を上げるまで端末に更新が届かない。
  // キャッシュを即返しつつ裏で取り直すことで、オフライン起動と更新の両方を satisfy する。
  event.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);

      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      const response = await network;
      return response ?? Response.error();
    }),
  );
});
