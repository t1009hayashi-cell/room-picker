/**
 * カレンダー画面（仕様書 8.1）。
 * 月表示・左右スワイプで月移動・表示モード切替・セール帯・件数バッジ・
 * 料率アップバッジ・長押しで想定報酬合計のポップアップ。
 */

import { app, navigate, setAppBar, toast } from '../main.js';
import { summarizeDay } from '../lib/catalog.js';
import { calendarGrid, escapeHtml, fmtYen, todayKey, WEEKDAY_JA } from '../lib/format.js';
import { salesOnDate } from '../lib/schedule.js';
import * as store from '../lib/store.js';

let cursor = null; // { year, month }

function initCursor() {
  if (cursor) return;
  const today = todayKey();
  cursor = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
}

function shiftMonth(delta) {
  let { year, month } = cursor;
  month += delta;
  while (month > 12) {
    month -= 12;
    year += 1;
  }
  while (month < 1) {
    month += 12;
    year -= 1;
  }
  cursor = { year, month };
}

export async function renderCalendar(root) {
  initCursor();
  const state = store.getState();
  const mode = state.settings.calendarMode;
  const catalog = app.catalog;
  const source = mode === 'discovered' ? catalog?.byDiscovered : catalog?.byScheduled;
  const today = todayKey();

  setAppBar('カレンダー');

  const cells = calendarGrid(cursor.year, cursor.month);
  const dowHeader = WEEKDAY_JA.map((d) => `<div class="cal__dow">${d}</div>`).join('');

  const cellHtml = cells
    .map((cell) => {
      // 発見日モードの byDiscovered は除外品も含む（仕様書6.1で残す設計のため）。
      // 日別リストの既定表示と件数・想定報酬合計が食い違わないよう、ここでも除外品を落とす。
      const items = (source?.get(cell.dateKey) ?? []).filter((item) => !item.userExcluded);
      const sum = summarizeDay(items, cell.dateKey, state);
      const daySales = salesOnDate(app.sales, cell.dateKey);
      const classes = [
        'cal__cell',
        cell.inMonth ? '' : 'cal__cell--out',
        cell.dateKey === today ? 'cal__cell--today' : '',
        daySales.length > 0 ? 'cal__cell--sale' : '',
      ]
        .filter(Boolean)
        .join(' ');

      const counts = [];
      if (sum.todo > 0) counts.push(`<span class="cal__count cal__count--todo">${sum.todo}</span>`);
      // 予約は「その日にやることがある」印なので、投稿済みより先に見えるようにする
      if (sum.reserved > 0) counts.push(`<span class="cal__count cal__count--reserved">予${sum.reserved}</span>`);
      if (sum.posted > 0) counts.push(`<span class="cal__count cal__count--posted">済${sum.posted}</span>`);
      if (sum.rateBoosted > 0) counts.push(`<span class="cal__count cal__count--rate">UP</span>`);

      const saleLabel =
        daySales.length > 0
          ? `<div class="cal__saleName">${escapeHtml(daySales.map((s) => s.displayName ?? s.name).join('/'))}</div>`
          : '';

      return `<div class="${classes}" data-dow="${cell.dow}" data-date="${cell.dateKey}" data-reward="${sum.reward}" data-count="${sum.total}">
        <span class="cal__date">${Number(cell.dateKey.slice(8))}</span>
        <div class="cal__counts">${counts.join('')}</div>
        ${saleLabel}
      </div>`;
    })
    .join('');

  const upcoming = app.sales
    .filter((sale) => Date.parse(sale.end) >= Date.now())
    .slice(0, 3)
    .map(
      (sale) =>
        `<li>${escapeHtml(sale.displayName ?? sale.name)} — ${sale.start.slice(5, 10)} 〜 ${sale.end.slice(5, 10)}${sale.source === 'auto' ? '（自動検出）' : ''}</li>`,
    )
    .join('');

  root.innerHTML = `
    <div class="chips" role="group" aria-label="表示モード">
      <button class="chip" data-mode="scheduled" aria-pressed="${mode === 'scheduled'}">投稿予定日</button>
      <button class="chip" data-mode="discovered" aria-pressed="${mode === 'discovered'}">発見日</button>
    </div>

    <div class="cal__head">
      <button class="btn btn--ghost" data-month="-1" aria-label="前の月">‹</button>
      <div class="cal__month">${cursor.year}年${cursor.month}月</div>
      <button class="btn btn--ghost" data-month="1" aria-label="次の月">›</button>
    </div>

    <div class="cal__grid" id="cal-grid">
      ${dowHeader}
      ${cellHtml}
    </div>

    <p class="small muted" style="margin-top:10px">
      日付を長押しすると、その日の想定報酬合計を表示します。
      読み込み済み: ${app.loadedDates.length}日分（${app.loadedDates[0] ?? '—'} 〜 ${app.loadedDates.at(-1) ?? '—'}）
    </p>

    ${upcoming ? `<h2>今後のセール</h2><ul class="small muted" style="padding-left:1.2em">${upcoming}</ul>` : ''}
  `;

  bind(root);
}

function bind(root) {
  root.querySelectorAll('[data-mode]').forEach((el) => {
    el.addEventListener('click', () => {
      store.updateSettings({ calendarMode: el.dataset.mode });
      renderCalendar(root);
    });
  });

  root.querySelectorAll('[data-month]').forEach((el) => {
    el.addEventListener('click', () => {
      shiftMonth(Number(el.dataset.month));
      renderCalendar(root);
    });
  });

  const grid = root.querySelector('#cal-grid');
  let longPressTimer = null;
  let longPressed = false;

  const startPress = (cell) => {
    longPressed = false;
    longPressTimer = setTimeout(() => {
      longPressed = true;
      const reward = Number(cell.dataset.reward) || 0;
      const count = Number(cell.dataset.count) || 0;
      toast(`${cell.dataset.date}: ${count}件 / 想定報酬合計 ${fmtYen(reward)}`, 2600);
    }, 480);
  };
  const cancelPress = () => clearTimeout(longPressTimer);

  grid.addEventListener('pointerdown', (event) => {
    const cell = event.target.closest('.cal__cell');
    if (cell) startPress(cell);
  });
  grid.addEventListener('pointerup', cancelPress);
  grid.addEventListener('pointercancel', cancelPress);
  grid.addEventListener('pointerleave', cancelPress);

  // 長押しの想定報酬ポップアップと、ブラウザ標準のコンテキストメニューが競合するため抑止する。
  grid.addEventListener('contextmenu', (event) => {
    if (event.target.closest('.cal__cell')) event.preventDefault();
  });

  grid.addEventListener('click', (event) => {
    const cell = event.target.closest('.cal__cell');
    if (!cell || longPressed) return;
    navigate(`#/day/${cell.dataset.date}`);
  });

  // 左右スワイプで月移動
  let startX = null;
  let startY = null;
  grid.addEventListener(
    'touchstart',
    (event) => {
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
    },
    { passive: true },
  );
  grid.addEventListener(
    'touchend',
    (event) => {
      if (startX === null) return;
      const dx = event.changedTouches[0].clientX - startX;
      const dy = event.changedTouches[0].clientY - startY;
      startX = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) {
        cancelPress();
        shiftMonth(dx < 0 ? 1 : -1);
        renderCalendar(root);
      }
    },
    { passive: true },
  );
}
