/**
 * 日別リスト画面（仕様書 8.2）。
 * hotScore 降順で商品カードを表示し、投稿文の編集と投稿ログの確定保存までを担う。
 */

import { app, setAppBar, toast, refreshData } from '../main.js';
import { applyChips, CHIP_FILTERS, isLimitedTimePrice, REASON_LABELS, sameShopPostedOnDate } from '../lib/filters.js';
import { copyToClipboard } from '../lib/prompt.js';
import { isDuringSale } from '../lib/schedule.js';
import { measureComment, splitComment } from '../lib/commentText.js';
import { toSearchQuery } from '../lib/itemName.js';
import { ANGLES, CRITERIA, HEADER_TYPES, extractPostFeatures } from '../lib/postFeatures.js';
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
/** 「今だけ安い」を含めた総合点。追加要件4章で一覧の既定の並び順にする */
const totalScore = (item) => (item.hotScore ?? 0) + (item.dealScore ?? 0);

const SORTS = [
  // カードの「hot 40+お得80」バッジがこの点数の内訳。選択欄の幅に収めるため名前は短くする
  { id: 'deal', label: 'おすすめ順', compare: (a, b) => totalScore(b) - totalScore(a) },
  { id: 'hot', label: 'hot順', compare: (a, b) => b.hotScore - a.hotScore },
  { id: 'discount', label: '割引率順', compare: (a, b) => (b.discount?.discountRate ?? 0) - (a.discount?.discountRate ?? 0) },
  // 「いま人気が出ている商品」を上に持ってくる
  { id: 'reviewGrowth', label: 'レビュー増加順', compare: (a, b) => (b.reviewCountChange ?? 0) - (a.reviewCountChange ?? 0) },
  { id: 'reward', label: '想定報酬順', compare: (a, b) => (b.estimatedReward ?? 0) - (a.estimatedReward ?? 0) },
  { id: 'point', label: 'ポイント倍率順', compare: (a, b) => (b.pointRate ?? 0) - (a.pointRate ?? 0) },
];
let sortId = 'deal';

/**
 * 投稿の状態での絞り込み。
 * 「予約のみ」が主役で、投稿予定日に開いて予約したものだけを見るための入口。
 */
/**
 * 投稿の状態での絞り込み。
 *
 * **未投稿／投稿済みは「商品ごと」で見る。**
 * 印そのものは押した日に紐づくが、絞り込みまで日ごとにすると
 * 別の日に出た同じ商品が「未投稿」に並び、二重投稿の元になる。
 */
const STATUS_FILTERS = [
  { id: 'all', label: 'すべて', test: () => true },
  { id: 'reserved', label: '予約のみ', test: (ctx) => Boolean(ctx.state.reserved[ctx.key]) },
  { id: 'unposted', label: '未投稿のみ', test: (ctx) => !ctx.postedIndex.has(ctx.itemCode) },
  { id: 'posted', label: '投稿済みのみ', test: (ctx) => ctx.postedIndex.has(ctx.itemCode) },
];
let statusId = 'all';

/** ジャンルでの絞り込み。'all' はすべて */
let genreFilter = 'all';

function applyStatus(items, state, dateKey, postedIndex) {
  const filter = STATUS_FILTERS.find((f) => f.id === statusId) ?? STATUS_FILTERS[0];
  if (filter.id === 'all') return items;
  return items.filter((item) =>
    filter.test({ state, postedIndex, itemCode: item.itemCode, key: store.dayItemKey(dateKey, item.itemCode) }),
  );
}

function applyGenre(items) {
  if (genreFilter === 'all') return items;
  return items.filter((item) => String(item.genreId) === genreFilter);
}

/** その日に出ているジャンルと件数。選択中のジャンルがその日に無ければ選択を解除する */
function genreChoices(items) {
  const counts = new Map();
  for (const item of items) {
    const key = String(item.genreId);
    if (!counts.has(key)) counts.set(key, { genreId: key, genreName: item.genreName, count: 0 });
    counts.get(key).count += 1;
  }
  const list = [...counts.values()].sort((a, b) => b.count - a.count || a.genreName.localeCompare(b.genreName, 'ja'));
  if (genreFilter !== 'all' && !counts.has(genreFilter)) genreFilter = 'all';
  return list;
}

function sortItems(items) {
  const sort = SORTS.find((s) => s.id === sortId) ?? SORTS[0];
  const tieBreak = (a, b) => b.hotScore - a.hotScore || a.itemCode.localeCompare(b.itemCode);
  // 元の配列はカタログが持っているものなので壊さない
  return [...items].sort((a, b) => sort.compare(a, b) || tieBreak(a, b));
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

  // ジャンルの選択肢はその日の全候補から作る（他の絞り込みで選択肢が消えないように）
  const dayItems = itemsForDate(dateKey);
  const genres = genreChoices(dayItems);

  // 日付・モード・絞り込み・並び順が変わったら先頭から描き直す
  const key = `${dateKey}|${mode}|${[...activeChips].sort().join(',')}|${showExcluded}|${sortId}|${statusId}|${genreFilter}`;
  if (key !== lastKey) {
    lastKey = key;
    visibleCount = PAGE_SIZE;
  }

  // 商品ごとの投稿履歴。別の日に投稿済みかを判定して二重投稿を防ぐ
  const postedIndex = store.buildPostedItemIndex(state.posts);

  const items = sortItems(applyGenre(applyStatus(applyChips(dayItems, activeChips), state, dateKey, postedIndex)));
  const reservedCount = dayItems.filter((item) => state.reserved[store.dayItemKey(dateKey, item.itemCode)]).length;
  const otherDayPostedCount = dayItems.filter(
    (item) => store.postedOnOtherDays(postedIndex, item.itemCode, dateKey).length > 0,
  ).length;
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
  const statusOptions = STATUS_FILTERS.map(
    (f) =>
      `<option value="${f.id}" ${f.id === statusId ? 'selected' : ''}>${f.label}${f.id === 'reserved' && reservedCount > 0 ? `（${reservedCount}）` : ''}</option>`,
  ).join('');

  const genreOptions = [
    `<option value="all" ${genreFilter === 'all' ? 'selected' : ''}>すべてのジャンル（${dayItems.length}）</option>`,
    ...genres.map(
      (g) =>
        `<option value="${escapeHtml(g.genreId)}" ${genreFilter === g.genreId ? 'selected' : ''}>${escapeHtml(g.genreName)}（${g.count}）</option>`,
    ),
  ].join('');

  root.innerHTML = `
    <div class="chips">${chips}${excludedChip}</div>
    <div class="filters">
      <label class="filters__wide"><span>ジャンル</span><select id="day-genre">${genreOptions}</select></label>
      <label><span>表示</span><select id="day-status">${statusOptions}</select></label>
      <label><span>並び順</span><select id="day-sort">${sortOptions}</select></label>
    </div>
    <p class="small muted">${mode === 'discovered' ? '発見日' : '投稿予定日'}モード / ${items.length}件 / 想定報酬合計 ${fmtYen(totalReward)}</p>
    ${
      otherDayPostedCount > 0 && statusId !== 'posted'
        ? `<p class="small muted">この日の候補のうち <strong>${otherDayPostedCount}件</strong> は別の日にすでに投稿しています。「表示: 未投稿のみ」にすると隠せます。</p>`
        : ''
    }
    ${shopConcentrationNotice(items)}
    <div id="day-items">
      ${items.length === 0 ? `<p class="empty">${emptyMessage()}</p>` : shown.map((item) => cardHtml(item, dateKey, state, postedIndex)).join('')}
    </div>
    ${rest > 0 ? `<button class="btn btn--block" data-more>さらに表示（残り${rest}件）</button>` : ''}
  `;

  bind(root, dateKey);
}

/**
 * 投稿の分類を選ぶ欄。
 *
 * **外部のAIで作った文章を貼って投稿するため、アプリ側では角度が分からない。**
 * 分析するには「どの角度・どのヘッダー型で投稿したか」が要るので、投稿前に選んでもらう。
 * 投稿プロンプトは「案1｜状況名指し × セール速報型」というラベルを出すので、
 * その2つをそのまま選ぶだけで済むようにしている。
 */
function postLabelHtml(code, state) {
  const label = state.postLabels?.[code] ?? {};
  const opts = (list, selected) =>
    ['<option value="">（未選択）</option>']
      .concat(list.map((v) => `<option value="${escapeHtml(v)}" ${v === selected ? 'selected' : ''}>${escapeHtml(v)}</option>`))
      .join('');

  const criteria = CRITERIA.map(
    (c) => `<label class="postlabel__check">
      <input type="checkbox" data-criteria="${escapeHtml(code)}" value="${escapeHtml(c)}" ${(label.criteria ?? []).includes(c) ? 'checked' : ''} />
      ${escapeHtml(c)}
    </label>`,
  ).join('');

  return `<details class="postlabel">
    <summary>投稿の分類${label.angle || label.headerType ? `（${escapeHtml([label.headerType, label.angle].filter(Boolean).join(' × '))}）` : '（未設定）'}</summary>
    <p class="small muted" style="margin:6px 0">
      AIが出した「案1｜状況名指し × セール速報型」のラベルをそのまま選んでください。
      分析はここで選んだ内容で層別されます。
    </p>
    <div class="filters">
      <label><span>ヘッダー型</span><select data-header-type="${escapeHtml(code)}">${opts(HEADER_TYPES, label.headerType)}</select></label>
      <label><span>角度</span><select data-angle-label="${escapeHtml(code)}">${opts(ANGLES, label.angle)}</select></label>
    </div>
    <p class="small muted" style="margin:2px 0 4px">選定基準（当てはまるものすべて）</p>
    <div class="postlabel__checks">${criteria}</div>
  </details>`;
}

/**
 * 直近でレビューがどれだけ増えたか。
 * 「いま人気が出ている商品」を見分ける材料。前日データが無ければ何も出さない
 * （0件増と「分からない」を区別する）。
 */
function reviewGrowth(item) {
  const change = item.reviewCountChange;
  if (change === null || change === undefined || change <= 0) return '';
  return ` <span class="item__growth">+${fmtNum(change)}</span>`;
}

/** 0件のときの案内。絞り込みのせいで0件なのか、その日に候補が無いのかを言い分ける */
function emptyMessage() {
  if (genreFilter !== 'all') return 'このジャンルに該当する商品はありません。ジャンルを「すべて」に戻すと表示されます。';
  if (statusId === 'reserved') return 'この日に予約した商品はありません。商品の「予約する」を押すとここに集まります。';
  if (statusId === 'posted') return 'この日に投稿済みの商品はありません。';
  if (statusId === 'unposted') return '未投稿の商品はありません。';
  return 'この日に該当する商品はありません。';
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

function cardHtml(item, dateKey, state, postedIndex) {
  // 投稿済み・予約は「この日のこの商品」に対する印。他の日には影響させない
  const stateKey = store.dayItemKey(dateKey, item.itemCode);
  const posted = Boolean(state.posted[stateKey]);
  const reserved = Boolean(state.reserved[stateKey]);
  // 同じ商品が複数の日に出るため、別の日で投稿済みかを必ず見せる（二重投稿の防止）
  const otherDays = store.postedOnOtherDays(postedIndex, item.itemCode, dateKey);
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

  const d = item.discount ?? {};
  const dealBadges = [
    // 割引が最も強い訴求なので先頭に出す（追加要件4章）
    d.discountRate !== null && d.discountRate !== undefined
      ? `<span class="badge badge--deal">${d.discountRate}%OFF</span>`
      : '',
    d.discountExpired ? '<span class="badge badge--warn">割引終了</span>' : '',
    d.hasCoupon ? '<span class="badge badge--coupon">クーポン</span>' : '',
    d.couponDeadlineRaw && !d.discountExpired
      ? `<span class="badge">${escapeHtml(d.couponDeadlineRaw)}</span>`
      : '',
    item.newcomerExempt ? '<span class="badge badge--new">新着</span>' : '',
  ]
    .filter(Boolean)
    .join('');

  const badges = [
    rankBadge,
    item.isRateBoosted
      ? `<span class="badge badge--rate">料率UP ${fmtPercent(item.affiliateRate, 1)}</span>`
      : `<span class="badge">料率 ${fmtPercent(item.affiliateRate, 1)}${item.affiliateRateSource === 'genre-fallback' ? '(推定)' : ''}</span>`,
    item.postageFlag === 0 ? '<span class="badge">送料込み</span>' : '<span class="badge badge--warn">送料別</span>',
    outOfStock ? '<span class="badge badge--down">在庫なし</span>' : '',
    // 追加要件3章: strong（5倍以上・期限つき）のときだけ倍率を出す。
    // weak（3〜4倍）と恒常設定は訴求材料にしない
    item.pointBoost === 'strong' ? `<span class="badge badge--warn">ポイント${item.pointRate}倍</span>` : '',
    isLimitedTimePrice(item) ? '<span class="badge badge--rate">期間限定価格</span>' : '',
    reserved ? '<span class="badge badge--reserved">予約済み</span>' : '',
    posted ? '<span class="badge badge--posted">投稿済み</span>' : '',
    // 押した日と区別できるよう、日付を添えて別バッジにする
    !posted && otherDays.length > 0
      ? `<span class="badge badge--posted">${escapeHtml(otherDays[otherDays.length - 1])}に投稿済み</span>`
      : '',
    `<span class="badge">hot ${item.hotScore}${item.dealScore ? `+お得${item.dealScore}` : ''}</span>`,
  ]
    .filter(Boolean)
    .join('');

  const warnings = [
    item.priceWarning ? `<div class="warnbar">${escapeHtml(item.priceWarning)}</div>` : '',
    item.priceMismatch
      ? `<div class="warnbar">表示価格(${fmtYen(item.itemPrice)})と価格帯(${fmtYen(item.itemPriceMin)}〜${fmtYen(item.itemPriceMax)})が食い違っています。商品ページで確認してください</div>`
      : '',
    // 同じ商品が別の日にも出るため、ここで気づけないと二重に投稿してしまう
    otherDays.length > 0 && !posted
      ? `<div class="warnbar warnbar--danger">この商品は <strong>${otherDays.map(escapeHtml).join('・')}</strong> にすでに投稿しています。ここで投稿すると同じ商品を重ねて出すことになります</div>`
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
        ${dealBadges ? `<div class="item__badges">${dealBadges}</div>` : ''}
        <div class="item__badges">${badges}</div>
        <div class="spread">
          <span class="item__price">
            ${
              d.priceBefore && d.priceAfter
                ? `<span class="item__priceBefore">${fmtYen(d.priceBefore)}</span> ${fmtYen(d.priceAfter)}`
                : priceNote
            }
          </span>
          <span class="item__meta">★${item.reviewAverage} / ${fmtNum(item.reviewCount)}件${reviewGrowth(item)}</span>
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
    ${postLabelHtml(item.itemCode, state)}

    <div class="actions">
      <button class="btn btn--primary" data-copy-comment="${escapeHtml(item.itemCode)}">投稿文をコピー</button>
      <button class="btn" data-copy-name="${escapeHtml(item.itemCode)}">商品名をコピー</button>
      <button class="btn" data-copy-url="${escapeHtml(item.itemCode)}" ${item.itemUrl ? '' : 'disabled'}>URLをコピー</button>
      <a class="btn" href="${escapeHtml(item.itemUrl)}" target="_blank" rel="noopener noreferrer">楽天で開く</a>
      ${
        item.reviewUrl
          ? `<a class="btn" href="${escapeHtml(item.reviewUrl)}" target="_blank" rel="noopener noreferrer">レビューを読む</a>`
          : ''
      }
    </div>
    <div class="spread" style="margin-top:8px">
      <span class="small muted">投稿予定日</span>
      <input type="date" value="${escapeHtml(scheduled)}" data-schedule="${escapeHtml(item.itemCode)}" data-schedule-from="${escapeHtml(scheduled)}" style="width:auto" />
    </div>

    ${
      posted
        ? ''
        : `<button class="btn ${reserved ? '' : 'btn--primary'} btn--block" data-reserve="${escapeHtml(item.itemCode)}">
            ${reserved ? '予約を取り消す' : 'この投稿文で予約する'}
          </button>`
    }
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
  const notes = [];
  if (m.endsWithPeriod) notes.push('文末の「。」を外す');
  if (m.longLines > 0) notes.push(`30字超の行が${m.longLines}行（20〜24字で改行）`);
  if (m.overallLength > 480) notes.push('タグ込みで480字を超えています');
  counter.innerHTML =
    `ヘッダー ${m.firstLineLength}字 / 本文 ${m.totalLength}字 / タグ込み ${m.overallLength}字 / ${m.lineCount}行 / タグ${m.hashtagCount}個` +
    (m.withinRules
      ? ''
      : `<span class="hint">推奨: ヘッダー20〜30字・本文250〜330字・タグ込み480字以内・タグ10〜15個${notes.length ? '／' + notes.join('・') : ''}</span>`);
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

  root.querySelector('#day-status')?.addEventListener('change', (event) => {
    statusId = event.target.value;
    renderDayList(root, dateKey);
  });

  root.querySelector('#day-genre')?.addEventListener('change', (event) => {
    genreFilter = event.target.value;
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
      // 予定日が変わるとカードが別の日に移るので、予約・投稿済みの印も一緒に移す
      store.setScheduledDate(code, el.value, el.dataset.scheduleFrom || null);
      toast(`投稿予定日を ${el.value} に変更しました`);
      // 割当が変わると別の日に移るため、カタログを組み直してこの日のリストを描き直す
      await refreshData();
      renderDayList(root, dateKey);
    });
  });

  root.querySelectorAll('[data-copy-comment]').forEach((el) => {
    el.addEventListener('click', async () => {
      const code = el.dataset.copyComment;
      // 画面で編集した内容をそのままコピーする（保存待ちの内容がズレないように）
      const area = root.querySelector(`[data-comment="${CSS.escape(code)}"]`);
      const text = area?.value ?? '';
      if (!text.trim()) return toast('投稿文が空です');
      store.setComment(code, text, store.getState().postedAngle[code]);
      const ok = await copyToClipboard(text);
      toast(ok ? '投稿文をコピーしました。楽天ROOMに貼り付けてください' : 'コピーに失敗しました');
    });
  });

  root.querySelectorAll('[data-reserve]').forEach((el) => {
    el.addEventListener('click', () => {
      const code = el.dataset.reserve;
      const state = store.getState();
      if (store.isReserved(dateKey, code)) {
        store.setReserved(dateKey, code, false);
        toast('予約を取り消しました');
        renderDayList(root, dateKey);
        return;
      }

      const area = root.querySelector(`[data-comment="${CSS.escape(code)}"]`);
      const text = area?.value ?? '';
      if (!text.trim()) return toast('投稿文を入力してから予約してください');

      store.setReserved(dateKey, code, true, { scheduledDate: dateKey, text, angle: state.postedAngle[code] });
      toast(`${dateKey} に予約しました。当日この日付を開くと「表示: 予約のみ」で出せます`);
      renderDayList(root, dateKey);
    });
  });

  root.querySelectorAll('[data-header-type]').forEach((el) => {
    el.addEventListener('change', () => {
      store.setPostLabel(el.dataset.headerType, { headerType: el.value || null });
      renderDayList(root, dateKey);
    });
  });

  root.querySelectorAll('[data-angle-label]').forEach((el) => {
    el.addEventListener('change', () => {
      store.setPostLabel(el.dataset.angleLabel, { angle: el.value || null });
      renderDayList(root, dateKey);
    });
  });

  root.querySelectorAll('[data-criteria]').forEach((el) => {
    el.addEventListener('change', () => {
      const code = el.dataset.criteria;
      const current = new Set(store.getPostLabel(code).criteria ?? []);
      if (el.checked) current.add(el.value);
      else current.delete(el.value);
      // 表示順を固定するため CRITERIA の並びに揃える
      store.setPostLabel(code, { criteria: CRITERIA.filter((c) => current.has(c)) });
    });
  });

  root.querySelectorAll('[data-copy-name]').forEach((el) => {
    el.addEventListener('click', async () => {
      const item = findItem(el.dataset.copyName);
      if (!item?.itemName) return toast('商品名が取得できていません');
      // 楽天の商品名は長すぎてROOMの検索で弾かれるため、検索用に短くしてコピーする
      const query = toSearchQuery(item.itemName);
      const ok = await copyToClipboard(query);
      // 何をコピーしたか見せる。短くしている以上、中身を確認できないと不安になる
      toast(ok ? `検索用にコピーしました: ${query}` : 'コピーに失敗しました', 3200);
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
      if (store.isPosted(dateKey, code)) {
        store.undoPost(dateKey, code);
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
      // 貼り付けた実際の投稿文から特徴を取る。生成した下書きではなくこれを見る
      const features = extractPostFeatures(raw);
      const label = store.getPostLabel(code);
      // アプリ全体を JST 固定で扱うため、投稿ログも +09:00 表記で残す
      const postedAt = nowJstIso();
      const sale = isDuringSale(app.sales, postedAt);

      // 仕様書 5.4: この記録がないと後から分析ができない
      store.addPost({
        postId: uuid(),
        postedAt,
        // 押したときに見ていた日。投稿済みの印をその日にだけ付けるために持つ
        dateKey,
        itemCode: item.itemCode,
        // 成果データとの突合キー。短縮・整形・トリムを一切行わない
        itemNameRaw: item.itemName,
        shopName: item.shopName,
        genreId: item.genreId,
        genreName: item.genreName,
        itemPrice: item.itemPrice,
        estimatedReward: item.estimatedReward,
        reviewCount: item.reviewCount,
        reviewCountChange: item.reviewCountChange ?? null,
        // 投稿前に選んでもらった分類。外部AIの文章を貼るため、これが無いと分析できない
        angle: label.angle ?? null,
        headerType: label.headerType ?? null,
        criteria: label.criteria ?? [],
        // 実際に投稿した文章から機械的に測れる特徴（analytics の層に使う）
        features,
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

      // 分類が無い投稿は分析で「（未設定）」に落ちる。あとから遡って付けられないので気づかせる
      toast(
        label.angle && label.headerType
          ? '投稿ログを保存しました'
          : '投稿ログを保存しました。「投稿の分類」が未設定です。分析に使うので選んでおいてください',
        label.angle && label.headerType ? 2200 : 4200,
      );
      renderDayList(root, dateKey);
    });
  });
}
