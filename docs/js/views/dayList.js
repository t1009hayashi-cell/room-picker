/**
 * 日別リスト画面（仕様書 8.2）。
 * hotScore 降順で商品カードを表示し、投稿文の編集と投稿ログの確定保存までを担う。
 */

import { app, setAppBar, toast, refreshData } from '../main.js';
import { applyChips, CHIP_FILTERS, isLimitedTimePrice, REASON_LABELS, sameShopPostedOnDate } from '../lib/filters.js';
import { buildAiPrompt, copyToClipboard } from '../lib/prompt.js';
import { isDuringSale } from '../lib/schedule.js';
import { measureComment, splitComment } from '../lib/commentText.js';
import * as store from '../lib/store.js';
import {
  charLength,
  escapeHtml,
  fmtDateShort,
  fmtNum,
  fmtPercent,
  fmtYen,
  isoToDateKey,
  nowJstIso,
  todayKey,
  uuid,
  weekdayOf,
} from '../lib/format.js';

const activeChips = new Set();
let showExcluded = false;

/**
 * 並び順。
 * 既定は hotScore 降順（仕様書 8.2）。同点のときの順序がぶれると
 * 「さらに表示」で同じ商品が二度出たり抜けたりするため、必ず itemCode で決着をつける。
 */
const SORTS = [
  { id: 'hot', label: 'hot順', compare: (a, b) => b.hotScore - a.hotScore },
  { id: 'reward', label: '想定報酬順', compare: (a, b) => (b.estimatedReward ?? 0) - (a.estimatedReward ?? 0) },
  { id: 'point', label: 'ポイント倍率順', compare: (a, b) => (b.pointRate ?? 0) - (a.pointRate ?? 0) },
  { id: 'unposted', label: '未投稿を先に', compare: null }, // 投稿状態が要るので下で個別に扱う
];
let sortId = 'hot';

function sortItems(items, posted) {
  const sort = SORTS.find((s) => s.id === sortId) ?? SORTS[0];
  const tieBreak = (a, b) => b.hotScore - a.hotScore || a.itemCode.localeCompare(b.itemCode);

  const compare =
    sort.id === 'unposted'
      ? (a, b) => Number(Boolean(posted[a.itemCode])) - Number(Boolean(posted[b.itemCode])) || tieBreak(a, b)
      : (a, b) => sort.compare(a, b) || tieBreak(a, b);

  // 元の配列はカタログが持っているものなので壊さない
  return [...items].sort(compare);
}

/**
 * 1度に描画する枚数。
 * セール開始日には数百件が集中し、全件を一度に描くと iPhone で明確に重くなる
 * （実測: 413件で DOM 12,536ノード / HTML 約970KB）。hotScore 降順は保ったまま分割して描く。
 */
const PAGE_SIZE = 30;
let visibleCount = PAGE_SIZE;
let lastKey = null;

function draftFor(item, angle) {
  const drafts = item.draftComments ?? [];
  return drafts.find((d) => d.angle === angle) ?? drafts[0] ?? null;
}

function fullText(draft) {
  if (!draft) return '';
  return `${draft.text}\n${draft.hashtags.join(' ')}`;
}

function itemsForDate(dateKey) {
  const state = store.getState();
  const mode = state.settings.calendarMode;
  if (mode === 'discovered') {
    const all = app.catalog?.byDiscovered.get(dateKey) ?? [];
    return showExcluded ? all : all.filter((item) => !item.userExcluded);
  }
  return app.catalog?.byScheduled.get(dateKey) ?? [];
}

export async function renderDayList(root, dateKey) {
  const state = store.getState();
  const mode = state.settings.calendarMode;
  setAppBar(`${dateKey}（${weekdayOf(dateKey)}）`, { back: true });

  // 日付・モード・絞り込み・並び順が変わったら先頭から描き直す
  const key = `${dateKey}|${mode}|${[...activeChips].sort().join(',')}|${showExcluded}|${sortId}`;
  if (key !== lastKey) {
    lastKey = key;
    visibleCount = PAGE_SIZE;
  }

  const items = sortItems(applyChips(itemsForDate(dateKey), activeChips), state.posted);
  const totalReward = items.reduce((sum, item) => sum + (item.estimatedReward ?? 0), 0);
  const shown = items.slice(0, visibleCount);
  const rest = items.length - shown.length;

  const chips = CHIP_FILTERS.map(
    (f) => `<button class="chip" data-chip="${f.id}" aria-pressed="${activeChips.has(f.id)}">${f.label}</button>`,
  ).join('');
  const excludedChip =
    mode === 'discovered'
      ? `<button class="chip" data-chip="__excluded" aria-pressed="${showExcluded}">除外も表示</button>`
      : '';

  const sortOptions = SORTS.map(
    (s) => `<option value="${s.id}" ${s.id === sortId ? 'selected' : ''}>${s.label}</option>`,
  ).join('');

  root.innerHTML = `
    <div class="chips">${chips}${excludedChip}</div>
    <label class="row small muted" style="margin-bottom:8px">
      <span>並び順</span>
      <select id="day-sort" style="width:auto;flex:1">${sortOptions}</select>
    </label>
    <p class="small muted">${mode === 'discovered' ? '発見日' : '投稿予定日'}モード / ${items.length}件 / 想定報酬合計 ${fmtYen(totalReward)}</p>
    ${shopConcentrationNotice(items)}
    <div id="day-items">
      ${items.length === 0 ? '<p class="empty">この日に該当する商品はありません。</p>' : shown.map((item) => cardHtml(item, dateKey, state)).join('')}
    </div>
    ${rest > 0 ? `<button class="btn btn--block" data-more>さらに表示（残り${rest}件）</button>` : ''}
  `;

  bind(root, dateKey);
}

/**
 * 同一ショップの候補がその日に固まっていることを、日単位で1行だけ知らせる。
 * カードごとに出すと候補の大半に警告が付き、仕様書8.2が求める「投稿済みの重複」警告が埋もれる。
 */
function shopConcentrationNotice(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.shopName, (counts.get(item.shopName) ?? 0) + 1);

  const worst = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!worst || worst[1] < 2) return '';
  return `<p class="small muted">同じショップの候補が重なっています（最多: ${escapeHtml(worst[0])} ${worst[1]}件）。クリック数はショップ単位でしか取れないため、投稿日を分けると分析しやすくなります。</p>`;
}

function cardHtml(item, dateKey, state) {
  const posted = Boolean(state.posted[item.itemCode]);
  const angle = state.postedAngle[item.itemCode] ?? item.draftComments?.[0]?.angle ?? null;
  const draft = draftFor(item, angle);
  const saved = state.comments[item.itemCode];
  const commentText = saved ?? fullText(draft);
  const scheduled = state.schedule[item.itemCode] ?? item.scheduledDate;

  const outOfStock = item.availability === 0;
  // 実際に投稿した日（今日）の重複が分析を壊すので、当日の投稿ログで判定する
  const sameShopPosted = sameShopPostedOnDate(state.posts, item.shopName, todayKey(), item.itemCode);

  const rankBadge = (() => {
    if (item.source === 'search') return '<span class="badge">検索</span>';
    if (item.isNew) return '<span class="badge badge--new">NEW</span>';
    if (item.rank === null) return '';
    const change = item.rankChange ?? 0;
    if (change > 0) return `<span class="badge badge--up">${item.rank}位 ↑${change}</span>`;
    if (change < 0) return `<span class="badge badge--down">${item.rank}位 ↓${-change}</span>`;
    return `<span class="badge">${item.rank}位 →</span>`;
  })();

  const badges = [
    rankBadge,
    item.isRateBoosted
      ? `<span class="badge badge--rate">料率UP ${fmtPercent(item.affiliateRate, 1)}</span>`
      : `<span class="badge">料率 ${fmtPercent(item.affiliateRate, 1)}${item.affiliateRateSource === 'genre-fallback' ? '(推定)' : ''}</span>`,
    item.postageFlag === 0 ? '<span class="badge">送料込み</span>' : '<span class="badge badge--warn">送料別</span>',
    outOfStock ? '<span class="badge badge--down">在庫なし</span>' : '',
    item.pointRate >= 5 ? `<span class="badge badge--warn">ポイント${item.pointRate}倍</span>` : '',
    isLimitedTimePrice(item) ? '<span class="badge badge--rate">期間限定価格</span>' : '',
    posted ? '<span class="badge badge--posted">投稿済み</span>' : '',
    `<span class="badge">hot ${item.hotScore}</span>`,
  ]
    .filter(Boolean)
    .join('');

  const warnings = [
    item.priceWarning ? `<div class="warnbar">${escapeHtml(item.priceWarning)}</div>` : '',
    item.priceMismatch
      ? `<div class="warnbar">表示価格(${fmtYen(item.itemPrice)})と価格帯(${fmtYen(item.itemPriceMin)}〜${fmtYen(item.itemPriceMax)})が食い違っています。商品ページで確認してください</div>`
      : '',
    sameShopPosted.length > 0
      ? `<div class="warnbar warnbar--danger">今日すでに同じショップ（${escapeHtml(item.shopName)}）の商品を${sameShopPosted.length}件投稿しています。いま投稿すると同日に重なり、クリック数はショップ単位でしか取れないため投稿別の分析ができなくなります</div>`
      : '',
    item.userExcluded
      ? `<div class="warnbar">除外中: ${item.userExcludeReasons.map((r) => REASON_LABELS[r] ?? r).join('、')}</div>`
      : '',
  ]
    .filter(Boolean)
    .join('');

  const angleTabs = (item.draftComments ?? [])
    .map(
      (d) =>
        `<button class="chip" data-angle="${escapeHtml(d.angle)}" data-code="${escapeHtml(item.itemCode)}" aria-pressed="${d.angle === angle}">${escapeHtml(d.angle)}</button>`,
    )
    .join('');

  const rewardNote = item.rewardCapApplied ? '（上限適用）' : item.isRateBoosted ? '（上限なし）' : '';
  const priceNote = item.hasPriceRange ? `${fmtYen(item.itemPriceMin)}から` : fmtYen(item.itemPrice);

  return `
  <article class="card ${outOfStock ? 'card--muted' : ''}" data-code="${escapeHtml(item.itemCode)}">
    ${warnings}
    <div class="item">
      ${item.imageUrl ? `<img class="item__thumb" src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy" />` : '<div class="item__thumb"></div>'}
      <div class="item__main">
        <p class="item__name" data-toggle-name>${escapeHtml(item.itemName)}</p>
        <div class="item__badges">${badges}</div>
        <div class="spread">
          <span class="item__price">${priceNote}</span>
          <span class="item__meta">★${item.reviewAverage} / ${fmtNum(item.reviewCount)}件</span>
        </div>
        <p class="item__meta">
          想定報酬 <strong>${fmtYen(item.estimatedReward)}</strong>${rewardNote}
          ・${escapeHtml(item.genreName)}・${escapeHtml(item.shopName)}
        </p>
      </div>
    </div>

    <details>
      <summary>商品説明</summary>
      <p class="caption">${escapeHtml(item.itemCaptionShort)}</p>
    </details>

    <p class="small muted" style="margin:8px 0 0">
      投稿予定日 <strong>${escapeHtml(scheduled)}</strong>（${escapeHtml(item.scheduleReason)}）
      ${item.pointRateStart ? `／ポイント期間 ${fmtDateShort(isoToDateKey(item.pointRateStart))}〜${fmtDateShort(isoToDateKey(item.pointRateEnd))}` : ''}
      ${item.priceEndTime ? `／価格期限 ${fmtDateShort(isoToDateKey(item.priceEndTime))}` : ''}
    </p>

    <div class="angle-tabs">${angleTabs}</div>
    <textarea data-comment="${escapeHtml(item.itemCode)}" aria-label="投稿文">${escapeHtml(commentText)}</textarea>
    <p class="small muted" data-counter="${escapeHtml(item.itemCode)}"></p>

    <div class="row" style="margin-top:8px">
      <input type="date" value="${escapeHtml(scheduled)}" data-schedule="${escapeHtml(item.itemCode)}" style="width:auto" />
      <button class="btn" data-copy="${escapeHtml(item.itemCode)}">AI用プロンプト</button>
      <button class="btn" data-copy-url="${escapeHtml(item.itemCode)}" ${item.itemUrl ? '' : 'disabled'}>URLをコピー</button>
      <a class="btn" href="${escapeHtml(item.itemUrl)}" target="_blank" rel="noopener noreferrer">楽天で開く</a>
    </div>
    <button class="btn ${posted ? '' : 'btn--primary'} btn--block" data-post="${escapeHtml(item.itemCode)}">
      ${posted ? '投稿済みを取り消す' : '投稿済みにする'}
    </button>
  </article>`;
}

function findItem(code) {
  return app.catalog?.latestByCode.get(code) ?? null;
}

function updateCounter(root, code) {
  const area = root.querySelector(`[data-comment="${CSS.escape(code)}"]`);
  const counter = root.querySelector(`[data-counter="${CSS.escape(code)}"]`);
  if (!area || !counter) return;
  const m = measureComment(area.value);
  counter.innerHTML = `1行目 ${m.firstLineLength}文字 / 本文 ${m.totalLength}文字 / ${m.lineCount}行 / タグ${m.hashtagCount}個 ${m.withinRules ? '' : '<span class="badge badge--warn">推奨: 1行目30〜35・本文80〜150・3行以内・タグ3〜4個</span>'}`;
}

function bind(root, dateKey) {
  root.querySelectorAll('[data-chip]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.chip;
      if (id === '__excluded') showExcluded = !showExcluded;
      else if (activeChips.has(id)) activeChips.delete(id);
      else activeChips.add(id);
      renderDayList(root, dateKey);
    });
  });

  root.querySelector('#day-sort')?.addEventListener('change', (event) => {
    sortId = event.target.value;
    renderDayList(root, dateKey);
  });

  root.querySelector('[data-more]')?.addEventListener('click', () => {
    // 日付・モード・絞り込みは変わらないので lastKey は据え置き。visibleCount だけ伸ばす
    visibleCount += PAGE_SIZE;
    renderDayList(root, dateKey);
  });

  root.querySelectorAll('[data-toggle-name]').forEach((el) => {
    el.addEventListener('click', () => el.classList.toggle('item__name--full'));
  });

  root.querySelectorAll('[data-angle]').forEach((el) => {
    el.addEventListener('click', () => {
      const { angle, code } = el.dataset;
      const item = findItem(code);
      const draft = draftFor(item, angle);
      store.update((s) => {
        s.postedAngle[code] = angle;
        s.comments[code] = fullText(draft);
      });
      renderDayList(root, dateKey);
    });
  });

  root.querySelectorAll('[data-comment]').forEach((el) => {
    const code = el.dataset.comment;
    updateCounter(root, code);
    el.addEventListener('input', () => updateCounter(root, code));
    el.addEventListener('change', () => {
      store.setComment(code, el.value, store.getState().postedAngle[code]);
      toast('投稿文を保存しました');
    });
  });

  root.querySelectorAll('[data-schedule]').forEach((el) => {
    el.addEventListener('change', async () => {
      const code = el.dataset.schedule;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(el.value)) return;
      store.setScheduledDate(code, el.value);
      toast(`投稿予定日を ${el.value} に変更しました`);
      // 割当が変わると別の日に移るため、カタログを組み直してこの日のリストを描き直す
      await refreshData();
      renderDayList(root, dateKey);
    });
  });

  root.querySelectorAll('[data-copy]').forEach((el) => {
    el.addEventListener('click', async () => {
      const code = el.dataset.copy;
      const item = findItem(code);
      if (!item) return;
      const ok = await copyToClipboard(buildAiPrompt(item));
      store.update((s) => {
        s.aiCopied[code] = true;
      });
      toast(ok ? 'AI用プロンプトをコピーしました' : 'コピーに失敗しました');
    });
  });

  root.querySelectorAll('[data-copy-url]').forEach((el) => {
    el.addEventListener('click', async () => {
      const item = findItem(el.dataset.copyUrl);
      if (!item?.itemUrl) return toast('この商品にはURLがありません');
      const ok = await copyToClipboard(item.itemUrl);
      toast(ok ? '商品URLをコピーしました' : 'コピーに失敗しました');
    });
  });

  root.querySelectorAll('[data-post]').forEach((el) => {
    el.addEventListener('click', () => {
      const code = el.dataset.post;
      const state = store.getState();
      if (state.posted[code]) {
        store.undoPost(code);
        toast('投稿済みを取り消しました');
        renderDayList(root, dateKey);
        return;
      }
      const item = findItem(code);
      if (!item) return;

      const area = root.querySelector(`[data-comment="${CSS.escape(code)}"]`);
      const raw = area?.value ?? '';
      store.setComment(code, raw, state.postedAngle[code]);

      const { body, hashtags } = splitComment(raw);
      const firstLine = body.split('\n')[0] ?? '';
      // アプリ全体を JST 固定で扱うため、投稿ログも +09:00 表記で残す
      const postedAt = nowJstIso();
      const sale = isDuringSale(app.sales, postedAt);

      // 仕様書 5.4: この記録がないと後から分析ができない
      store.addPost({
        postId: uuid(),
        postedAt,
        itemCode: item.itemCode,
        // 成果データとの突合キー。短縮・整形・トリムを一切行わない
        itemNameRaw: item.itemName,
        shopName: item.shopName,
        genreId: item.genreId,
        genreName: item.genreName,
        itemPrice: item.itemPrice,
        estimatedReward: item.estimatedReward,
        reviewCount: item.reviewCount,
        angle: state.postedAngle[code] ?? item.draftComments?.[0]?.angle ?? null,
        firstLine,
        firstLineLength: charLength(firstLine),
        commentBody: body,
        hashtags,
        usedAiGeneration: Boolean(state.aiCopied[code]),
        duringSale: sale.during,
        saleId: sale.saleId,
        rankAtPost: item.rank,
        rankChangeAtPost: item.rankChange,
      });

      toast('投稿ログを保存しました');
      renderDayList(root, dateKey);
    });
  });
}
