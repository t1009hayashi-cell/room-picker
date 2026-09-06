/**
 * ルーティングとアプリ全体の状態。
 * 画面は #/calendar, #/day/YYYY-MM-DD, #/analytics, #/settings の4つ。
 */

import { loadIndex, loadSales, loadSnapshots, resetCache } from './lib/dataLoader.js';
import { buildCatalog } from './lib/catalog.js';
import { mergeSaleSources } from './lib/schedule.js';
import * as store from './lib/store.js';
import { escapeHtml } from './lib/format.js';
import { renderCalendar } from './views/calendar.js';
import { renderDayList } from './views/dayList.js';
import { renderAnalytics } from './views/analytics.js';
import { renderLikes } from './views/likes.js';
import { renderSettings } from './views/settings.js';

const viewEl = document.getElementById('view');
const titleEl = document.getElementById('appbar-title');
const rightEl = document.getElementById('appbar-right');
const backEl = document.querySelector('[data-action="back"]');
const toastEl = document.getElementById('toast');
const a2hsEl = document.getElementById('a2hs');

export const app = {
  index: null,
  salesAuto: [],
  sales: [],
  catalog: null,
  loadedDates: [],
  error: null,
};

let toastTimer = null;
export function toast(message, ms = 2200) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.hidden = false;
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, ms);
}

export function setAppBar(title, { back = false, right = '' } = {}) {
  titleEl.textContent = title;
  backEl.hidden = !back;
  rightEl.innerHTML = right;
}

export function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

/** 日次データを読み直してカタログを作る */
export async function refreshData({ force = false } = {}) {
  if (force) resetCache();
  const state = store.getState();

  const [index, salesFile] = await Promise.all([loadIndex(), loadSales()]);
  app.index = index;
  app.salesAuto = salesFile.sales ?? [];
  app.sales = mergeSaleSources(app.salesAuto, state.manualSales, state.settings.saleLabels ?? {});

  const window = Math.max(1, Number(state.settings.calendarWindowDays) || 31);
  const dates = (index.dates ?? []).slice(-window);
  app.loadedDates = dates;

  const snapshots = await loadSnapshots(dates);
  app.catalog = buildCatalog({
    snapshots,
    sales: app.sales,
    settings: state.settings,
    schedule: state.schedule,
  });
  return app.catalog;
}

/** 設定変更などでカタログだけ組み直す（再フェッチしない） */
export async function rebuildCatalog() {
  await refreshData();
}

function parseRoute() {
  const parts = (location.hash || '#/calendar').replace(/^#\/?/, '').split('/');
  return { path: parts[0] || 'calendar', param: parts[1] ?? '' };
}

function setActiveTab(path) {
  // 日別リストはカレンダーから、いいね記録は分析から入るので、親のタブを光らせる
  const tab = path === 'day' ? 'calendar' : path === 'likes' ? 'analytics' : path;
  document.querySelectorAll('.tabbar__item').forEach((el) => {
    if (el.dataset.tab === tab) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
}

/** いま表示している画面の識別子。スクロール位置の保存キーに使う */
let currentRouteKey = null;

/**
 * 画面を描く。
 *
 * **同じ画面を描き直すときはスクロール位置を保つ。**
 * 以前は毎回先頭に戻していたため、チェックを1つ入れるだけで一覧の先頭に飛ばされ、
 * 商品を探し直すことになっていた。画面が変わったときだけ先頭に戻す。
 */
export async function render() {
  const { path, param } = parseRoute();
  const routeKey = `${path}/${param}`;
  const sameView = routeKey === currentRouteKey;
  const keepY = sameView ? window.scrollY : null;

  setActiveTab(path);
  currentRouteKey = routeKey;
  // 続きから開けるように、最後に見ていた画面を控える
  store.setLastRoute(location.hash);

  if (app.error) {
    viewEl.innerHTML = `<div class="card"><strong>データを読み込めませんでした</strong><p class="small muted">${escapeHtml(app.error)}</p><button class="btn btn--block" data-action="retry">再試行</button></div>`;
    setAppBar('エラー');
    return;
  }

  try {
    switch (path) {
      case 'day':
        await renderDayList(viewEl, param);
        break;
      case 'analytics':
        await renderAnalytics(viewEl);
        break;
      case 'likes':
        await renderLikes(viewEl);
        break;
      case 'settings':
        await renderSettings(viewEl);
        break;
      default:
        await renderCalendar(viewEl);
    }
  } catch (err) {
    console.error(err);
    viewEl.innerHTML = `<div class="card"><strong>画面の描画に失敗しました</strong><p class="small muted">${escapeHtml(err.message)}</p></div>`;
  }

  restoreScroll(routeKey, keepY);
}

/**
 * スクロール位置を戻す。
 * 同じ画面の描き直しなら直前の位置、別の画面なら前回その画面を見ていた位置。
 * 描画直後は高さが確定していないことがあるので、次のフレームで当てる。
 */
function restoreScroll(routeKey, keepY) {
  // 作業中の商品がその日にあるなら、保存した位置よりそちらを優先する。
  // 日別リスト側が商品までスクロールするので、ここでは何もしない
  if (keepY === null && hasFreshFocus(routeKey)) return;

  const y = keepY ?? store.getScrollPos(routeKey);
  if (y <= 0) return;
  // 画像や遅延読み込みで高さが後から伸びる。1度では届かないことがあるので数回試す
  const apply = () => window.scrollTo(0, y);
  requestAnimationFrame(apply);
  setTimeout(apply, 120);
  setTimeout(apply, 400);
}

/** その画面に「直近の作業中の商品」があるか。古い作業まで拾うと勝手に飛ばされるので24時間で切る */
function hasFreshFocus(routeKey) {
  const focus = store.getFocus();
  if (!focus?.dateKey || routeKey !== `day/${focus.dateKey}`) return false;
  const hours = (Date.now() - Date.parse(focus.at ?? '')) / 3600000;
  return Number.isFinite(hours) && hours <= 24;
}

/** 画面を離れるときに位置を控える。iOSはPWAを黙って終了させるので pagehide でも保存する */
function saveScroll() {
  if (currentRouteKey) store.setScrollPos(currentRouteKey, window.scrollY);
}
window.addEventListener('pagehide', saveScroll);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveScroll();
});

/* ---- ホーム画面追加の案内（仕様書 5.5 iOSの制約） ---- */
function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

function maybeShowA2hs() {
  const state = store.getState();
  if (isStandalone() || state.meta.a2hsDismissed) return;
  const isIos = /iP(hone|ad|od)/.test(navigator.userAgent);
  if (!isIos) return;
  a2hsEl.hidden = false;
}

document.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'back') {
    if (history.length > 1) history.back();
    else navigate('#/calendar');
  } else if (action === 'a2hs-dismiss') {
    store.update((s) => {
      s.meta.a2hsDismissed = true;
    });
    a2hsEl.hidden = true;
  } else if (action === 'a2hs-later') {
    a2hsEl.hidden = true;
  } else if (action === 'retry') {
    app.error = null;
    boot();
  }
});

/**
 * 起動が終わるまで hashchange を無視する。
 * `boot()` がハッシュを入れ直すと hashchange が飛び、`await render()` と二重に走る。
 * 二重に走ると、後から終わったほうが「同じ画面の描き直し」と判断して
 * その時点のスクロール位置（＝0）を採用してしまい、復元した位置が打ち消される。
 */
let booted = false;
window.addEventListener('hashchange', () => {
  if (booted) render();
});

async function boot() {
  // ブラウザ任せの復元と、こちらの復元がぶつかると位置が飛ぶ
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  store.load();
  store.onPersistError(toast);
  try {
    await refreshData();
    app.error = null;
  } catch (err) {
    console.error(err);
    app.error = `${err.message}（data/index.json を配置してください）`;
  }
  // iOSはPWAを終了させることがあり、そのとき start_url（ハッシュ無し）から起動する。
  // 外部のAIに文章を作らせて戻ってきたときに最初の画面に戻らないよう、続きから開く
  if (!location.hash) location.hash = store.getLastRoute() ?? '#/calendar';
  await render();
  booted = true;
  maybeShowA2hs();

  if (store.shouldRemindExport()) {
    toast('前回のエクスポートから1ヶ月以上経っています。設定画面からバックアップしてください', 5000);
  }
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW登録に失敗しました', err));
  });
}

boot();
