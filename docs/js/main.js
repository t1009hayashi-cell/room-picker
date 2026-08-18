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

export async function render() {
  const { path, param } = parseRoute();
  setActiveTab(path);
  // 前の画面のスクロール位置が残ると、内容の短い画面で
  // 表示位置がずれたように見えるため先頭に戻す。
  window.scrollTo(0, 0);

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
}

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

window.addEventListener('hashchange', render);

async function boot() {
  store.load();
  store.onPersistError(toast);
  try {
    await refreshData();
    app.error = null;
  } catch (err) {
    console.error(err);
    app.error = `${err.message}（data/index.json を配置してください）`;
  }
  if (!location.hash) location.hash = '#/calendar';
  await render();
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
