/**
 * 日別リスト画面（仕様書 8.2）。
 * hotScore 降順で商品カードを表示し、投稿文の編集と投稿ログの確定保存までを担う。
 */

import { app, setAppBar, toast, refreshData } from '../main.js';
import { applyChips, CHIP_FILTERS, isLimitedTimePrice, REASON_LABELS, sameShopPostedOnDate } from '../lib/filters.js';
import { copyToClipboard } from '../lib/prompt.js';
import { isDuringSale } from '../lib/schedule.js';
import { headerLine, measureComment, splitComment } from '../lib/commentText.js';
import { toSearchQuery } from '../lib/itemName.js';
import { chooseOne, confirmAction } from '../lib/modal.js';
import { buildPools, priceTierOf } from '../lib/pools.js';
import { buildManualItem, parseItemUrl } from '../lib/manualItem.js';
import { roomUrlFor } from '../lib/room.js';
import { ORIGINAL_PHOTO_TAG, suggestTags, tagLine } from '../lib/tagSuggest.js';
import { CRITERIA, HEADER_TYPES, LABEL_VERSION, extractPostFeatures } from '../lib/postFeatures.js';
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

/**
 * 並び替え。
 *
 * **「おすすめ順」だけは価格帯で組み直す**（追加要件v1.3 2章）。
 * スコア降順に素直に並べると、割引率の加点が大きい高単価商品ばかりが上に来る。
 * リーチ枠（1,000〜3,000円）とのの比率を「出力の構造」で担保するため、
 * プールを分けて交互に取り出す。他の並び順は指定どおりの単純なソートのままにする
 * （「割引率順」を価格帯で崩すと、何を見ているのか分からなくなるため）。
 */
function sortItems(items, reachRatio) {
  const sort = SORTS.find((s) => s.id === sortId) ?? SORTS[0];
  const tieBreak = (a, b) => b.hotScore - a.hotScore || a.itemCode.localeCompare(b.itemCode);

  // 手動で足した商品はスコアを持たない（0点）ため、素直に並べると最後尾に沈んで
  // 「追加したのに出てこない」状態になる。**ユーザーが意図して選んだものなので必ず先頭に置く。**
  const manual = items.filter((i) => i.source === 'manual');
  const rest = items.filter((i) => i.source !== 'manual');

  // 元の配列はカタログが持っているものなので壊さない
  const sorted = [...rest].sort((a, b) => sort.compare(a, b) || tieBreak(a, b));
  if (sortId !== 'deal') {
    return { items: [...manual, ...sorted], reachShort: false, reachCount: 0, revenueCount: 0 };
  }
  const pooled = buildPools(sorted, { reachRatio });
  return { ...pooled, items: [...manual, ...pooled.items] };
}

/**
 * 1度に描画する枚数。
 * セール開始日には数百件が集中し、全件を一度に描くと iPhone で明確に重くなる
 * （実測: 413件で DOM 12,536ノード / HTML 約970KB）。hotScore 降順は保ったまま分割して描く。
 */
const PAGE_SIZE = 30;
let visibleCount = PAGE_SIZE;
let lastKey = null;

function itemsForDate(dateKey) {
  const state = store.getState();
  const mode = state.settings.calendarMode;
  const base =
    mode === 'discovered'
      ? (() => {
          const all = app.catalog?.byDiscovered.get(dateKey) ?? [];
          return showExcluded ? all : all.filter((item) => !item.userExcluded);
        })()
      : (app.catalog?.byScheduled.get(dateKey) ?? []);

  // 手動追加した商品は除外条件に関係なく必ず出す（追加要件v1.3 5.3）。
  // ユーザーが意図して選んだものなので、こちらの判断で上書きしない
  const manual = (state.manualItems ?? [])
    .filter((m) => m.dateKey === dateKey)
    .map((m) => ({ ...m, scheduledDate: dateKey, scheduleReason: '手動追加', userExcluded: false, userExcludeReasons: [] }));
  if (manual.length === 0) return base;

  const codes = new Set(base.map((i) => i.itemCode));
  return [...base, ...manual.filter((m) => !codes.has(m.itemCode))];
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

  const pooled = sortItems(
    applyGenre(applyStatus(applyChips(dayItems, activeChips), state, dateKey, postedIndex)),
    state.settings.reachRatio,
  );
  const items = pooled.items;
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
    ${poolNotice(pooled, state.settings.reachRatio)}
    ${shopConcentrationNotice(items)}
    <div id="day-items">
      ${items.length === 0 ? `<p class="empty">${emptyMessage()}</p>` : shown.map((item) => cardHtml(item, dateKey, state, postedIndex)).join('')}
    </div>
    ${rest > 0 ? `<button class="btn btn--block" data-more>さらに表示（残り${rest}件）</button>` : ''}

    <button class="btn btn--block" data-action="add-manual">商品を手動で追加</button>
    <p class="small muted" style="margin:4px 0 0">
      候補一覧に出てこない商品を投稿するときに使います。
      記録しておかないと分析から漏れます（投稿した全件が揃っていないと比率も平均も出せません）。
    </p>
  `;

  bind(root, dateKey);
}

/**
 * リーチ枠が足りないときの注意（追加要件v1.3 2.2 手順5）。
 * 補充が起きたことを黙って隠すと、比率を守れていないことに気づけない。
 */
function poolNotice(pooled, reachRatio) {
  if (sortId !== 'deal') return '';
  if (!pooled.reachShort) return '';
  const pct = Math.round((reachRatio ?? 0.7) * 100);
  return `<div class="warnbar">
    リーチ枠（1,000〜3,000円）の候補が不足しています（リーチ${pooled.reachCount}件 / 収益${pooled.revenueCount}件）。
    ${pct}%に届かないぶんは収益枠で埋めています。
    レビュー件数の条件が低単価商品で満たされにくい可能性があります。
  </div>`;
}

/** 価格帯のバッジ。どちらの枠として選んだのかを一目で分かるようにする */
function tierBadge(item) {
  const tier = priceTierOf(item);
  return tier === 'reach'
    ? '<span class="badge badge--reach">リーチ枠</span>'
    : '<span class="badge badge--revenue">収益枠</span>';
}

/**
 * 選定理由（追加要件v1.3 3章）。
 *
 * **ここの文字列を投稿文にそのまま転記しないこと。**
 * 「レビュー1,981件」のような数値の転記は既存の禁止事項に反する。
 * AIが理由を理解するための材料として渡すもの。
 */
function criteriaHtml(item, state) {
  const detail = item.criteriaDetail;
  const override = state.criteriaOverride?.[item.itemCode];
  if (!detail) {
    return `<p class="small muted" style="margin:6px 0 0">
      選定理由はこの日のデータには入っていません（追加要件v1.3より前に取得した分）。
    </p>`;
  }

  const rows = CRITERIA.map((name) => {
    const r = detail[name] ?? { matched: false, reason: null, confidence: '確定' };
    // スーパー判定は推定なので、手動で上書きした結果を優先する
    const matched = name === 'スーパーにない' && override !== undefined ? override : r.matched;
    const confidence = name === 'スーパーにない' && override !== undefined ? '手動' : r.confidence;
    return `<li class="criteria__row ${matched ? '' : 'criteria__row--off'}">
      <span class="criteria__mark">${matched ? '✅' : '—'}</span>
      <div class="criteria__body">
        <span class="criteria__name">${escapeHtml(name)}</span>
        ${matched ? `<span class="criteria__conf">${escapeHtml(confidence)}</span>` : ''}
        <span class="criteria__reason small muted">${escapeHtml(matched ? (r.reason ?? '手動で該当にしました') : '該当なし')}</span>
      </div>
    </li>`;
  }).join('');

  return `<ul class="criteria">${rows}</ul>
    <label class="postlabel__check" style="margin-top:4px">
      <input type="checkbox" data-supermarket="${escapeHtml(item.itemCode)}" ${
        (override !== undefined ? override : detail['スーパーにない']?.matched) ? 'checked' : ''
      } />
      「スーパーにない」に該当する（推定なので手で直せます）
    </label>`;
}

/** 手動追加した商品の警告（追加要件v1.3 5.3）。除外はしないが理由は必ず見せる */
function manualWarningHtml(item) {
  if (item.source !== 'manual') return '';
  const list = item.manualWarnings ?? [];
  return `<div class="warnbar">
    手動で追加した商品です（データは手入力のため、選定ロジックの検証には使いません）。
    ${list.length === 0 ? '' : `<br>⚠ 通常の抽出条件では除外されます：${escapeHtml(list.join(' / '))}`}
  </div>`;
}

/** ヘッダー型の説明。何を見て選ぶのかを1行で示す（判定は「投稿した1行目」だけで決まる） */
const HEADER_TYPE_NOTES = {
  共感課題型: '1行目が読み手の悩み・状況から始まる',
  お得条件型: '1行目が割引率・価格・期限から始まる',
  称号実績型: '1行目が受賞歴・ランキング・実績から始まる',
  商品特徴型: '1行目が容量・加工・スペックから始まる',
  判定不可: 'どれにも当てはまらない',
};

/**
 * 投稿の補助欄（選定基準・購入済み・タグ候補）。
 *
 * **ヘッダー型はここに置かない。** 投稿ログ47件中27件が空欄になったのは、
 * 入れなくても投稿を確定できたため。ヘッダー型は「投稿済みにする」の直前に
 * ダイアログで必ず選んでもらう（追加要件v1.2 1.3）。
 */
function postLabelHtml(item, state) {
  const code = item.itemCode;
  const label = state.postLabels?.[code] ?? {};
  const purchased = Boolean(state.purchased?.[code]);

  const criteria = CRITERIA.map(
    (c) => `<label class="postlabel__check">
      <input type="checkbox" data-criteria="${escapeHtml(code)}" value="${escapeHtml(c)}" ${(label.criteria ?? []).includes(c) ? 'checked' : ''} />
      ${escapeHtml(c)}
    </label>`,
  ).join('');

  // 過去に使ったタグを渡して、自分のコレクションタグを候補に残す
  const past = state.posts.flatMap((p) => p.hashtags ?? []);
  const tags = suggestTags(item.itemName, { pastHashtags: past });
  const tagRow = (title, list, note) =>
    list.length === 0
      ? ''
      : `<div class="tagrow">
          <div class="tagrow__head"><span class="tagrow__title">${escapeHtml(title)}</span><span class="small muted">${escapeHtml(note)}</span></div>
          <div class="tagrow__tags">${list.map((tag) => `<button class="chip chip--tag" data-copy-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</button>`).join('')}</div>
          <button class="btn btn--ghost small" data-copy-tags="${escapeHtml(tagLine(list))}">この層をまとめてコピー</button>
        </div>`;

  return `<details class="postlabel">
    <summary>投稿の補助（選定基準・購入済み・タグ候補）</summary>

    <label class="postlabel__purchase">
      <input type="checkbox" data-purchased="${escapeHtml(code)}" ${purchased ? 'checked' : ''} />
      <span>この商品は購入済み</span>
    </label>
    <p class="small muted" style="margin:2px 0 8px">
      購入済みにすると、URLをコピーしたときにAIへ「一人称の体験談を書いてよい」と伝える1行が付きます。
      自分で撮った写真を使う場合は <strong>#${escapeHtml(ORIGINAL_PHOTO_TAG)}</strong> も付けてください。
    </p>

    <p class="small muted" style="margin:2px 0 4px">選定基準（当てはまるものすべて）</p>
    <div class="postlabel__checks">${criteria}</div>

    <p class="small muted" style="margin:10px 0 4px">
      ハッシュタグ候補（タップでコピー）。フォロワーが少ないうちは<strong>ニッチが唯一の露出経路</strong>です。
    </p>
    ${tagRow('ニッチ', tags.niche, '3〜5個')}
    ${tagRow('中規模', tags.mid, '3〜4個')}
    ${tagRow('ビッグ', tags.big, '2〜3個')}
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
  // 投稿文はアプリで生成しない（外部のAIで作った文章を貼る運用）。
  // 予約時などに保存したものがあればそれを出し、無ければ空で始める
  const commentText = state.comments[item.itemCode] ?? '';
  const scheduled = state.schedule[item.itemCode] ?? item.scheduledDate;

  const outOfStock = item.availability === 0;
  // 実際に投稿した日（今日）の重複が分析を壊すので、当日の投稿ログで判定する
  const sameShopPosted = sameShopPostedOnDate(state.posts, item.shopName, todayKey(), item.itemCode);

  const rankBadge = (() => {
    if (item.source === 'manual') return '<span class="badge badge--manual">手動</span>';
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
        <div class="item__badges">${tierBadge(item)}${badges}</div>
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

    ${manualWarningHtml(item)}

    <details>
      <summary>選定理由（${item.matchedCriteria?.length ?? 0}件該当）</summary>
      ${criteriaHtml(item, state)}
      <p class="small muted" style="margin:6px 0 0">
        ここの文言は<strong>投稿文にそのまま書かないでください</strong>。
        AIに理由を伝えるための材料です（レビュー件数の転記は禁止事項に当たります）。
      </p>
    </details>

    <details>
      <summary>商品説明</summary>
      <p class="caption">${escapeHtml(item.itemCaptionShort)}</p>
    </details>

    <p class="small muted" style="margin:8px 0 0">
      投稿予定日 <strong>${escapeHtml(scheduled)}</strong>（${escapeHtml(item.scheduleReason)}）
      ${item.pointRateStart ? `／ポイント期間 ${fmtDateShort(isoToDateKey(item.pointRateStart))}〜${fmtDateShort(isoToDateKey(item.pointRateEnd))}` : ''}
      ${item.priceEndTime ? `／価格期限 ${fmtDateShort(isoToDateKey(item.priceEndTime))}` : ''}
    </p>

    <textarea data-comment="${escapeHtml(item.itemCode)}" aria-label="投稿文">${escapeHtml(commentText)}</textarea>
    <p class="small muted" data-counter="${escapeHtml(item.itemCode)}"></p>
    ${postLabelHtml(item, state)}

    <div class="actions">
      <button class="btn btn--primary" data-copy-comment="${escapeHtml(item.itemCode)}">投稿文をコピー</button>
      <button class="btn" data-copy-name="${escapeHtml(item.itemCode)}">商品名をコピー</button>
      <button class="btn" data-copy-url="${escapeHtml(item.itemCode)}" ${item.itemUrl ? '' : 'disabled'}>URLをコピー</button>
      <a class="btn" href="${escapeHtml(item.itemUrl)}" target="_blank" rel="noopener noreferrer">楽天で開く</a>
      <a class="btn" href="${escapeHtml(roomUrlFor(item))}" target="_blank" rel="noopener noreferrer" data-room="${escapeHtml(item.itemCode)}">ROOMに投稿</a>
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
    ${posted ? likesHtml(dateKey, item.itemCode) : ''}
  </article>`;
}

/**
 * いいね数の記録欄（追加要件v1.2 2.1）。
 *
 * ROOMにAPIはなく、画面もJavaScript描画のため自動では取れない。
 * 週1回 my ROOM を見て転記する運用を想定している。
 * **上書きせず履歴で持つ。** 投稿直後と1週間後で伸び方が違うため、
 * 初速を見るには「いつ測ったか」が要る。
 */
function likesHtml(dateKey, itemCode) {
  const post = store.findPost(dateKey, itemCode);
  if (!post) return '';
  const latest = store.latestLike(post);
  const history = (post.likes ?? [])
    .slice(-4)
    .map((l) => `${fmtNum(l.count)}（${fmtDateShort(String(l.measuredAt).slice(0, 10))}）`)
    .join(' → ');

  return `<div class="likes">
    <div class="spread">
      <span class="small muted">いいね数</span>
      <span class="small">${latest ? `<strong>${fmtNum(latest.count)}</strong>` : '未記録'}</span>
    </div>
    <div class="likes__input">
      <input type="number" inputmode="numeric" min="0" step="1" placeholder="my ROOMの数値" data-like="${escapeHtml(post.postId)}" aria-label="いいね数" />
      <button class="btn" data-like-save="${escapeHtml(post.postId)}">記録</button>
    </div>
    ${history ? `<p class="small muted" style="margin:4px 0 0">${escapeHtml(history)}</p>` : ''}
  </div>`;
}

/**
 * 商品を手動で足すフォーム（追加要件v1.3 5章）。
 *
 * **URLだけで楽天APIから引いてくることはできない。**
 * アプリIDとアクセスキーは公開リポジトリに置けず、静的サイトから叩けば必ず露出する。
 * そのため 5.4 の「最小限の手入力」を正の入口にしている。
 * URLからは itemCode とショップコードだけを機械的に取り出す。
 */
function openManualDialog(root, dateKey) {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.innerHTML = `
    <div class="modal__panel" role="dialog" aria-modal="true" aria-label="商品を手動で追加">
      <h3 class="modal__title">商品を手動で追加</h3>
      <p class="small muted" style="margin:0 0 10px">
        候補一覧に出てこない商品を投稿するときに使います。
        <strong>投稿した全件が記録されていないと、比率も平均も出せません。</strong>
      </p>
      <label class="field"><span>楽天の商品URL（必須）</span>
        <input type="url" inputmode="url" data-m="url" placeholder="https://item.rakuten.co.jp/…" /></label>
      <label class="field"><span>商品名（必須）</span><input type="text" data-m="name" /></label>
      <label class="field"><span>価格（必須・円）</span><input type="number" inputmode="numeric" min="0" data-m="price" /></label>
      <label class="field"><span>ショップ名（必須）</span><input type="text" data-m="shop" /></label>
      <label class="field"><span>レビュー件数（任意）</span><input type="number" inputmode="numeric" min="0" data-m="rc" /></label>
      <label class="field"><span>レビュー平均（任意）</span><input type="number" inputmode="decimal" min="0" max="5" step="0.01" data-m="ra" /></label>
      <label class="field"><span>投稿した文章（任意・すでに投稿済みなら貼ってください）</span>
        <textarea data-m="text" placeholder="ROOMに投稿した本文をそのまま貼る"></textarea></label>
      <label class="postlabel__purchase">
        <input type="checkbox" data-m="posted" />
        <span>すでにROOMに投稿済みとして記録する</span>
      </label>
      <p class="small muted" style="margin:2px 0 10px">
        投稿ログを作ります。<strong>いいね数の入力欄はこれを作ってから出ます。</strong>
        あとから商品カードの「投稿済みにする」でも同じことができます。
      </p>
      <p class="small muted" style="margin:0 0 10px">
        手入力分は <code>手入力</code> の印が付き、選定ロジックの検証には使いません（データの質が違うため）。
      </p>
      <p class="hint" data-m="error" hidden></p>
      <button class="btn btn--primary btn--block" data-m="save">追加する</button>
      <button class="btn btn--ghost modal__cancel">やめる</button>
    </div>
  `;

  const close = () => overlay.remove();
  const val = (k) => overlay.querySelector(`[data-m="${k}"]`).value.trim();
  const error = overlay.querySelector('[data-m="error"]');
  const fail = (message) => {
    error.textContent = message;
    error.hidden = false;
  };

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target.closest('.modal__cancel')) close();
  });

  overlay.querySelector('[data-m="save"]').addEventListener('click', () => {
    const parsed = parseItemUrl(val('url'));
    if (!parsed.ok) return fail(parsed.error);
    if (val('name') === '') return fail('商品名を入れてください');
    if (val('shop') === '') return fail('ショップ名を入れてください');
    const price = Number(val('price'));
    if (!Number.isFinite(price) || price <= 0) return fail('価格を数字で入れてください');

    const settings = store.getState().settings;
    const item = buildManualItem(
      {
        ...parsed,
        itemName: val('name'),
        itemPrice: price,
        shopName: val('shop'),
        reviewCount: val('rc'),
        reviewAverage: val('ra'),
        addedAt: nowJstIso(),
      },
      settings,
    );
    // 手動追加はその日の候補として持つ。日をまたいで一覧に出し続けないため
    store.addManualItem({ ...item, dateKey });

    const text = overlay.querySelector('[data-m="text"]').value;
    if (text.trim() !== '') store.setComment(item.itemCode, text);
    const markPosted = overlay.querySelector('[data-m="posted"]').checked;
    close();

    if (markPosted) {
      // 投稿ログまで作る。**手動追加の目的は「投稿した全件を記録すること」**なので、
      // ここで作らないと分析から漏れたままになる（＝いいね数も入れられない）
      recordPost(root, dateKey, item.itemCode, { openRoom: false });
      return;
    }

    toast(
      item.manualWarnings.length === 0
        ? '追加しました。いいね数を入れるには「投稿済みにする」を押してください'
        : `追加しました。通常の抽出条件では除外される商品です（${item.manualWarnings.join(' / ')}）`,
      4200,
    );
    renderDayList(root, dateKey);
  });

  document.body.appendChild(overlay);
  overlay.querySelector('[data-m="url"]').focus();
}

/**
 * 商品コードから商品を引く。
 *
 * **手動追加した商品はカタログに入っていない。**
 * カタログだけを見ていると、手動追加の商品では「投稿済みにする」が
 * 無言で何もせずに終わり、投稿ログが作られない（＝いいね数の入力欄も出ない）。
 * 手動追加を記録する目的そのものが果たせなくなるため、こちらも必ず探す。
 */
/**
 * 投稿ログを1件確定させる（仕様書 5.4）。
 *
 * 商品カードの「投稿済みにする」と、手動追加フォームの「すでに投稿済み」の
 * **両方から呼ぶ。** 手動追加は「投稿した全件を記録する」ことが目的なので、
 * 追加したその場でログを作れないと目的を果たせない（いいね数も入れられない）。
 *
 * `openRoom` を立てると、保存後に「投稿文をコピーしてROOMに投稿」を出す。
 * すでに投稿済みのものを記録するときは不要なので出さない。
 */
async function recordPost(root, dateKey, code, { text = null, openRoom = true } = {}) {
  const state = store.getState();
  const item = findItem(code);
  if (!item) {
    // ここに来るのは商品を引けなかったとき。黙って終わると原因が分からないので必ず知らせる
    toast('商品が見つかりません。データを読み直してからもう一度お試しください', 4200);
    return;
  }

  const raw = text ?? store.getComment(code) ?? '';
  store.setComment(code, raw);

  const { body, hashtags } = splitComment(raw);
  // 1.4: 先頭の空行やタグ行ではなく、本文の最初の中身のある行をヘッダーとして残す
  const firstLine = headerLine(raw);

  // 1.3: 分類を選ばないと確定できない。実際に投稿した1行目を見せて、その場で判定してもらう
  const headerType = await chooseOne({
    title: '投稿の1行目はどれ？',
    description: firstLine === '' ? '（1行目が空です。分からなければ「判定不可」を選んでください）' : firstLine,
    options: HEADER_TYPES.map((v) => ({ value: v, label: v, note: HEADER_TYPE_NOTES[v] })),
    cancelLabel: 'まだ記録しない',
  });
  if (headerType === null) {
    renderDayList(root, dateKey);
    return;
  }
  store.setPostLabel(code, { headerType });

  // 貼り付けた実際の投稿文から特徴を取る。生成した下書きではなくこれを見る
  const features = extractPostFeatures(raw);
  const label = store.getPostLabel(code);
  const purchased = Boolean(state.purchased?.[code]);
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
    // いいね一覧で「どの商品か」を見分けるために残す。カタログから消えても分かるようにする
    imageUrl: item.imageUrl ?? null,
    itemUrl: item.itemUrl ?? null,
    shopName: item.shopName,
    genreId: item.genreId,
    genreName: item.genreName,
    itemPrice: item.itemPrice,
    estimatedReward: item.estimatedReward,
    reviewCount: item.reviewCount,
    reviewCountChange: item.reviewCountChange ?? null,
    // 投稿時に選んでもらった分類。外部AIの文章を貼るため、これが無いと分析できない
    headerType,
    criteria: label.criteria ?? [],
    /** 選定理由（追加要件v1.3 3章）。どの基準で選んだ商品が伸びたかを後から見るため */
    priceTier: priceTierOf(item),
    matchedCriteria: item.matchedCriteria ?? [],
    /** ランキング由来か手動追加か。分析で分けられるようにする（5.5） */
    itemSource: item.source ?? 'ranking',
    dataSource: item.dataSource ?? 'api',
    /** 分類方式の世代。v1（角度あり）とは集計を混ぜない（1.5） */
    labelVersion: LABEL_VERSION,
    /** 実際に買った商品か。体験談・オリジナル写真の効果を測るための層（3章） */
    purchased,
    // 実際に投稿した文章から機械的に測れる特徴（analytics の層に使う）
    features,
    firstLine,
    firstLineLength: charLength(firstLine),
    commentBody: body,
    // 4.3: タグは本文から機械的に取る。列によって入り方が違う状態を無くす
    hashtags,
    usedAiGeneration: Boolean(state.aiCopied[code]),
    duringSale: sale.during,
    saleId: sale.saleId,
    rankAtPost: item.rank,
    rankChangeAtPost: item.rankChange,
  });

  const warn = [];
  if (hashtags.length === 0) warn.push('ハッシュタグが本文から見つかりません');
  if (purchased && !hashtags.some((tag) => tag.includes(ORIGINAL_PHOTO_TAG))) {
    warn.push(`購入済みなら #${ORIGINAL_PHOTO_TAG} を付けてください`);
  }

  if (openRoom) {
    // 分類まで終わったら、そのままROOMの投稿画面へ渡す。
    // コピーと遷移をこのボタンのタップの中でやる（iOSのポップアップ制限とクリップボード制限のため）
    await confirmAction({
      title: `保存しました（${headerType}）`,
      description: warn.length === 0 ? '投稿文をコピーしてROOMを開きます。' : warn.join(' / '),
      href: roomUrlFor(item),
      actionLabel: '投稿文をコピーしてROOMに投稿',
      note: 'ROOMのこの商品の投稿画面が開きます。コメント欄に貼り付けてください（未ログインなら楽天のログインを挟みます）。',
      closeLabel: 'あとで投稿する',
      onActivate: () => {
        copyToClipboard(raw);
      },
    });
  } else {
    toast(
      warn.length === 0
        ? `投稿ログを保存しました（${headerType}）。いいね数を入れられます`
        : `保存しました。${warn.join(' / ')}`,
      4200,
    );
  }
  renderDayList(root, dateKey);
}

function findItem(code) {
  const fromCatalog = app.catalog?.latestByCode.get(code);
  if (fromCatalog) return fromCatalog;
  return store.getState().manualItems?.find((m) => m.itemCode === code) ?? null;
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


  root.querySelectorAll('[data-comment]').forEach((el) => {
    const code = el.dataset.comment;
    updateCounter(root, code);
    el.addEventListener('input', () => updateCounter(root, code));
    el.addEventListener('change', () => {
      store.setComment(code, el.value);
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
      store.setComment(code, text);
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

      store.setReserved(dateKey, code, true, { scheduledDate: dateKey, text });
      toast(`${dateKey} に予約しました。当日この日付を開くと「表示: 予約のみ」で出せます`);
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
      // 追加要件v1.2 3.2: 購入済みならAIに体験談を書いてよいと伝える。
      // 投稿文の生成は廃止したので、AIに渡るのはこのURLだけ。ここに書き添えるしかない。
      // URLを1行目に置いて、URLだけ使いたいときも壊れないようにする
      const purchased = Boolean(store.getState().purchased?.[item.itemCode]);
      const text = purchased
        ? `${item.itemUrl}
【この商品は購入済み。一人称の体験談を書いてよい】`
        : item.itemUrl;
      const ok = await copyToClipboard(text);
      toast(
        ok
          ? purchased
            ? '購入済みの注記つきでURLをコピーしました'
            : '商品URLをコピーしました'
          : 'コピーに失敗しました',
      );
    });
  });

  root.querySelectorAll('[data-post]').forEach((el) => {
    el.addEventListener('click', async () => {
      const code = el.dataset.post;
      if (store.isPosted(dateKey, code)) {
        store.undoPost(dateKey, code);
        toast('投稿済みを取り消しました');
        renderDayList(root, dateKey);
        return;
      }
      const area = root.querySelector(`[data-comment="${CSS.escape(code)}"]`);
      await recordPost(root, dateKey, code, { text: area?.value ?? '', openRoom: true });
    });
  });

  root.querySelectorAll('[data-like-save]').forEach((el) => {
    el.addEventListener('click', () => {
      const postId = el.dataset.likeSave;
      const input = root.querySelector(`[data-like="${CSS.escape(postId)}"]`);
      const count = Number(input?.value);
      if (!Number.isFinite(count) || count < 0 || input.value.trim() === '') {
        return toast('いいね数を数字で入れてください');
      }
      // 記録した日を持つ。投稿直後と1週間後で伸び方が違うため、いつの値かが要る
      store.addLikeCount(postId, Math.round(count), nowJstIso());
      toast('いいね数を記録しました');
      renderDayList(root, dateKey);
    });
  });

  root.querySelectorAll('[data-purchased]').forEach((el) => {
    el.addEventListener('change', () => {
      store.setPurchased(el.dataset.purchased, el.checked);
      toast(el.checked ? '購入済みにしました。体験談とオリジナル写真が使えます' : '購入済みを外しました');
      renderDayList(root, dateKey);
    });
  });

  root.querySelectorAll('[data-supermarket]').forEach((el) => {
    el.addEventListener('change', () => {
      // 自動判定は商品名からの推定なので、人の判断を上書きとして残す（追加要件v1.3 4.3）
      store.setCriteriaOverride(el.dataset.supermarket, el.checked);
      toast(el.checked ? '「スーパーにない」に該当としました' : '「スーパーにない」を外しました');
      renderDayList(root, dateKey);
    });
  });

  root.querySelector('[data-action="add-manual"]')?.addEventListener('click', () => {
    openManualDialog(root, dateKey);
  });

  root.querySelectorAll('[data-copy-tag], [data-copy-tags]').forEach((el) => {
    el.addEventListener('click', async () => {
      const text = el.dataset.copyTags ?? `#${el.dataset.copyTag}`;
      const ok = await copyToClipboard(text);
      toast(ok ? `コピーしました: ${text}` : 'コピーに失敗しました', 2600);
    });
  });
}
