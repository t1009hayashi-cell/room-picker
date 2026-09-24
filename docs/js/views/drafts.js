/**
 * 下書き・予約の一覧。
 *
 * **なぜ必要か。**
 * 予約を取り消すと `reserved` の記録は消えるが、**投稿文（`comments`）は残る。**
 * ところがその投稿文にたどり着く手段が、日別リストを端から見ていくしかなかった。
 * 商品は投稿予定日が動くと別の日へ移るので、取り消した日を開いても無いことがある。
 *
 * ここでは日をまたいで「まだ投稿していないが手を付けた商品」を一覧にする。
 * 投稿済みのものは投稿一覧（#/likes）で見るので、ここには出さない。
 */

import { app, setAppBar, toast } from '../main.js';
import { toSearchQuery } from '../lib/itemName.js';
import { roomPostUrl } from '../lib/room.js';
import { escapeHtml, fmtDateShort, fmtNum, fmtYen } from '../lib/format.js';
import * as store from '../lib/store.js';

/** 'all' | 'reserved' | 'draft' */
let filter = 'all';

const FILTERS = [
  { key: 'all', label: 'すべて' },
  { key: 'reserved', label: '予約中' },
  { key: 'draft', label: '下書きのみ' },
];

/**
 * 手を付けた商品を集める。
 *
 * - 予約中：`reserved` に残っている（日付ごと）
 * - 下書き：投稿文はあるが予約されていない（＝予約を取り消した、または書きかけ）
 *
 * 投稿済みの商品は除く。やることが残っているものだけを出す。
 */
function collect(state) {
  const postedIndex = store.buildPostedItemIndex(state.posts);
  const rows = new Map();

  const put = (itemCode, patch) => {
    const current = rows.get(itemCode) ?? { itemCode };
    rows.set(itemCode, { ...current, ...patch });
  };

  // 予約は「日付|itemCode」で持っている。取り消した日のものはここに残らない
  for (const [key, value] of Object.entries(state.reserved ?? {})) {
    const [dateKey, ...rest] = key.split('|');
    const itemCode = rest.join('|');
    if (!itemCode || postedIndex.has(itemCode)) continue;
    put(itemCode, { reserved: true, dateKey: value?.scheduledDate ?? dateKey, reservedAt: value?.reservedAt ?? null });
  }

  for (const [itemCode, text] of Object.entries(state.comments ?? {})) {
    if (!String(text ?? '').trim()) continue;
    if (postedIndex.has(itemCode)) continue;
    put(itemCode, { text });
  }

  return [...rows.values()]
    .map((row) => {
      const item = app.catalog?.latestByCode.get(row.itemCode) ?? null;
      return {
        ...row,
        text: row.text ?? state.comments?.[row.itemCode] ?? '',
        itemName: item?.itemName ?? '',
        imageUrl: item?.imageUrl ?? null,
        estimatedReward: item?.estimatedReward ?? null,
        // 予約が無い下書きは、その商品がいま割り当てられている日を行き先にする
        dateKey: row.dateKey ?? state.schedule?.[row.itemCode] ?? item?.scheduledDate ?? null,
        stillListed: Boolean(item),
      };
    })
    // 予約中を先に、その中では日付の近い順
    .sort((a, b) => Number(Boolean(b.reserved)) - Number(Boolean(a.reserved)) || String(a.dateKey).localeCompare(String(b.dateKey)));
}

function matches(row) {
  if (filter === 'reserved') return Boolean(row.reserved);
  if (filter === 'draft') return !row.reserved;
  return true;
}

function rowHtml(row) {
  // 商品名が取れないのは、日次JSONの読み込み範囲から外れた古い商品
  const name = row.itemName ? toSearchQuery(row.itemName, 26) : `(商品名なし) ${row.itemCode}`;
  const head = String(row.text ?? '').split(String.fromCharCode(10)).find((l) => l.trim() !== '') ?? '';

  return `<div class="likerow">
    <div class="likerow__top">
      ${
        row.imageUrl
          ? `<img class="likerow__thumb" src="${escapeHtml(row.imageUrl)}" alt="" loading="lazy" />`
          : '<div class="likerow__thumb likerow__thumb--empty" aria-hidden="true">—</div>'
      }
      <div class="likerow__body">
        <div class="likerow__head">
          <span class="likerow__name">${escapeHtml(name)}</span>
          <span class="likerow__now">${row.reserved ? '<span class="badge badge--reserved">予約中</span>' : '<span class="badge">下書き</span>'}</span>
        </div>
        <p class="likerow__meta small muted">
          ${row.dateKey ? `${escapeHtml(fmtDateShort(row.dateKey))}の一覧` : '日付が分かりません'}
          ${row.estimatedReward !== null ? `・想定報酬 ${escapeHtml(fmtYen(row.estimatedReward))}` : ''}
          ${row.stillListed ? '' : '・<strong>いまの候補にはありません</strong>'}
        </p>
        ${head ? `<p class="small muted" style="margin:0">${escapeHtml(head.slice(0, 40))}</p>` : ''}
      </div>
    </div>
    <div class="draftrow__actions">
      ${
        row.dateKey && row.stillListed
          ? `<a class="btn btn--primary draftrow__open" href="#/day/${escapeHtml(row.dateKey)}" data-open-draft="${escapeHtml(row.itemCode)}">一覧で開く</a>`
          : '<span class="small muted draftrow__open">一覧に無いため開けません</span>'
      }
      ${
        roomPostUrl(row.itemCode)
          ? `<a class="btn likerow__link" href="${escapeHtml(roomPostUrl(row.itemCode))}" target="_blank" rel="noopener noreferrer">ROOM</a>`
          : ''
      }
      <button class="btn likerow__del" data-drop-draft="${escapeHtml(row.itemCode)}" aria-label="下書きを消す">削除</button>
    </div>
  </div>`;
}

export async function renderDrafts(root) {
  setAppBar('下書き・予約', { back: true });
  const state = store.getState();
  const all = collect(state);
  const rows = all.filter(matches);
  const reservedCount = all.filter((r) => r.reserved).length;

  root.innerHTML = `
    <div class="card">
      <p class="small" style="margin:0 0 6px">
        まだ投稿していない、<strong>投稿文を書いた商品</strong>の一覧です。
        予約を取り消しても投稿文は残るので、ここから探せます。
      </p>
      <p class="small muted" style="margin:0">
        全${fmtNum(all.length)}件（予約中 ${fmtNum(reservedCount)}件）。投稿済みのものは
        <a href="#/likes">投稿一覧</a>にあります。
      </p>
    </div>

    <div class="chips" role="group" aria-label="絞り込み">
      ${FILTERS.map((f) => `<button class="chip" data-filter="${f.key}" aria-pressed="${filter === f.key}">${f.label}</button>`).join('')}
    </div>

    ${
      rows.length === 0
        ? `<p class="empty">${
            all.length === 0
              ? '下書きも予約もありません。商品カードで投稿文を書くとここに並びます。'
              : 'この条件に当てはまるものはありません。「すべて」に戻すと全件出ます。'
          }</p>`
        : rows.map(rowHtml).join('')
    }
  `;

  bind(root);
}

function bind(root) {
  root.querySelectorAll('[data-filter]').forEach((el) => {
    el.addEventListener('click', () => {
      filter = el.dataset.filter;
      renderDrafts(root);
    });
  });

  root.querySelectorAll('[data-open-draft]').forEach((el) => {
    // 日別リストは「作業中の商品」まで自動で送るので、開く前に印を付ける
    el.addEventListener('click', () => {
      const code = el.dataset.openDraft;
      const item = app.catalog?.latestByCode.get(code);
      store.setFocus(el.getAttribute('href').split('/').pop(), code, item?.itemName ?? '');
    });
  });

  root.querySelectorAll('[data-drop-draft]').forEach((el) => {
    el.addEventListener('click', () => {
      if (!window.confirm('この商品の投稿文を消します。予約していれば予約も取り消します。よろしいですか？')) return;
      store.dropDraft(el.dataset.dropDraft);
      toast('下書きを消しました');
      renderDrafts(root);
    });
  });
}
