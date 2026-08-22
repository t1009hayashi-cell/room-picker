/**
 * いいね数の記録画面（追加要件v1.2 2.1）。
 *
 * **なぜ専用の画面が要るか。**
 * いいね数の入力欄は日別リストの商品カードの中にあるが、それだと
 * 「投稿した日を思い出して、その日を開いて、カードまで探す」必要がある。
 * 想定している運用は**週1回まとめて転記する**ことなので、
 * 投稿を一覧にして、上から順に数字を埋めていける形にする。
 *
 * 数値は上書きせず履歴で積む。投稿直後と1週間後で伸び方が違い、
 * 初速の判定に使うため「いつ測ったか」が要る。
 */

import { app, setAppBar, toast } from '../main.js';
import { toSearchQuery } from '../lib/itemName.js';
import { roomPostUrl } from '../lib/room.js';
import { escapeHtml, fmtDateShort, fmtNum, isoToDateKey, nowJstIso, todayKey } from '../lib/format.js';
import * as store from '../lib/store.js';

/** 'all' | 'unrecorded' | 'stale' */
let filter = 'unrecorded';

const FILTERS = [
  { key: 'unrecorded', label: '未記録' },
  { key: 'stale', label: '前回から7日以上' },
  { key: 'all', label: 'すべて' },
];

/** 投稿日からの経過日数。初速（投稿直後）と定着（1週間後）を見分けるのに使う */
function daysSince(dateKey, base = todayKey()) {
  const ms = Date.parse(`${base}T00:00:00Z`) - Date.parse(`${dateKey}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.round(ms / 86400000);
}

function postDateKey(post) {
  return post.dateKey ?? isoToDateKey(post.postedAt) ?? '';
}

/** 最後に測ってから何日経ったか。未記録なら null */
function daysSinceMeasured(post) {
  const latest = store.latestLike(post);
  if (!latest) return null;
  return daysSince(String(latest.measuredAt).slice(0, 10));
}

function matchesFilter(post) {
  if (filter === 'all') return true;
  const latest = store.latestLike(post);
  if (filter === 'unrecorded') return latest === null;
  // 'stale': 一度は測ったが、しばらく更新していないもの
  return latest !== null && (daysSinceMeasured(post) ?? 0) >= 7;
}

function rowHtml(post) {
  const dateKey = postDateKey(post);
  const elapsed = daysSince(dateKey);
  const latest = store.latestLike(post);
  // 楽天の商品名は長いので、販促文を落とした短い形で出す
  const name = toSearchQuery(post.itemNameRaw ?? '', 26) || post.itemNameRaw || '(商品名なし)';
  const history = (post.likes ?? [])
    .slice(-3)
    .map((l) => `${fmtNum(l.count)}（${fmtDateShort(String(l.measuredAt).slice(0, 10))}）`)
    .join(' → ');

  return `<div class="likerow">
    <div class="likerow__top">
      ${
        post.imageUrl
          ? `<img class="likerow__thumb" src="${escapeHtml(post.imageUrl)}" alt="" loading="lazy" />`
          : '<div class="likerow__thumb likerow__thumb--empty" aria-hidden="true">—</div>'
      }
      <div class="likerow__body">
        <div class="likerow__head">
          <span class="likerow__name">${escapeHtml(name)}</span>
          <span class="likerow__now">${latest ? `<strong>${fmtNum(latest.count)}</strong>` : '<span class="muted">未記録</span>'}</span>
        </div>
        <p class="likerow__meta small muted">
          ${escapeHtml(fmtDateShort(dateKey))}に投稿${elapsed === null ? '' : `・${elapsed}日前`}
          ${post.headerType ? `・${escapeHtml(post.headerType)}` : ''}
          ${post.purchased ? '・購入済み' : ''}
        </p>
        ${history ? `<p class="small muted" style="margin:0">${escapeHtml(history)}</p>` : ''}
      </div>
    </div>
    <div class="likes__input">
      <input type="number" inputmode="numeric" min="0" step="1" placeholder="いいね数" data-like="${escapeHtml(post.postId)}" aria-label="${escapeHtml(name)} のいいね数" />
      ${
        roomPostUrl(post.itemCode)
          ? `<a class="btn likerow__link" href="${escapeHtml(roomPostUrl(post.itemCode))}" target="_blank" rel="noopener noreferrer">ROOM</a>`
          : ''
      }
    </div>
  </div>`;
}

export async function renderLikes(root) {
  setAppBar('いいね数', { back: true });
  const state = store.getState();
  // 新しい投稿ほど数字が動くので上に置く
  const all = [...state.posts]
    .sort((a, b) => String(b.postedAt ?? '').localeCompare(String(a.postedAt ?? '')))
    // 商品URLは投稿ログに持っていないので、いま読み込んでいるカタログから補う。
    // 見つからなければボタンを押せない状態にする（過去の商品は日次JSONから落ちる）
    // 商品URLと画像は投稿ログに持っていないので、いま読み込んでいるカタログから補う。
    // 見つからなければリンクを出さない（古い商品は日次JSONから落ちる）
    .map((post) => {
      const item = app.catalog?.latestByCode.get(post.itemCode);
      return {
        ...post,
        itemUrl: post.itemUrl ?? item?.itemUrl ?? null,
        // 画像はタイトルだけだとどの商品か分からないため出す
        imageUrl: post.imageUrl ?? item?.imageUrl ?? null,
      };
    });
  const rows = all.filter(matchesFilter);

  const unrecorded = all.filter((p) => store.latestLike(p) === null).length;

  root.innerHTML = `
    <div class="card">
      <p class="small" style="margin:0 0 6px">
        my ROOM を開いて、上から順にいいね数を入れてください。
        入れ終わったら下の<strong>「まとめて記録」</strong>を1回押します。
      </p>
      <p class="small muted" style="margin:0">
        投稿 ${fmtNum(all.length)}件 / 未記録 ${fmtNum(unrecorded)}件。
        数値は上書きせず履歴で残るので、同じ投稿に何度でも入れられます（初速と伸びを見分けるため）。
      </p>
    </div>

    <div class="chips" role="group" aria-label="絞り込み">
      ${FILTERS.map((f) => `<button class="chip" data-filter="${f.key}" aria-pressed="${filter === f.key}">${f.label}</button>`).join('')}
    </div>

    ${
      rows.length === 0
        ? `<p class="empty">${
            all.length === 0
              ? '投稿ログがまだありません。日別リストで「投稿済みにする」を押すとここに並びます。'
              : 'この条件に当てはまる投稿はありません。「すべて」に切り替えると全件出ます。'
          }</p>`
        : rows.map(rowHtml).join('')
    }

    ${rows.length === 0 ? '' : '<button class="btn btn--primary btn--block" data-action="save-likes">まとめて記録</button>'}
  `;

  bind(root);
}

function bind(root) {
  root.querySelectorAll('[data-filter]').forEach((el) => {
    el.addEventListener('click', () => {
      filter = el.dataset.filter;
      renderLikes(root);
    });
  });

  root.querySelector('[data-action="save-likes"]')?.addEventListener('click', () => {
    const inputs = [...root.querySelectorAll('[data-like]')];
    // 同じ時刻で記録する。1回の転記作業をひとまとまりとして後から追えるようにする
    const measuredAt = nowJstIso();
    let saved = 0;
    const invalid = [];

    for (const input of inputs) {
      const raw = input.value.trim();
      if (raw === '') continue; // 空欄は「今回は入れない」の意味。触らない
      const count = Number(raw);
      if (!Number.isFinite(count) || count < 0) {
        invalid.push(raw);
        continue;
      }
      store.addLikeCount(input.dataset.like, Math.round(count), measuredAt);
      saved += 1;
    }

    if (saved === 0 && invalid.length === 0) return toast('いいね数がどこにも入っていません');
    toast(
      invalid.length === 0
        ? `${saved}件のいいね数を記録しました`
        : `${saved}件を記録しました。数字でない入力が${invalid.length}件あったので飛ばしています`,
      invalid.length === 0 ? 2400 : 4200,
    );
    renderLikes(root);
  });
}
