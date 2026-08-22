/**
 * ローカル状態（仕様書 5.3 / 5.4 / 5.5）。
 *
 * iOS の Safari は、ホーム画面に追加していないサイトのストレージを一定期間で削除することがある。
 * そのため
 *  - 初回起動時に「ホーム画面に追加」を促す
 *  - JSONのエクスポート／インポートを用意する
 *  - 月1回エクスポートを促す
 * を必須とする。ここではその状態も保持する。
 */

import { HEADER_TYPES } from './postFeatures.js';

const KEY = 'room-assist:v1';
const EXPORT_REMINDER_DAYS = 30;

/**
 * 投稿済み・予約の記録キー。
 *
 * 商品コードだけで持つと、同じ商品が複数の日に出たとき（発見日モードでは
 * ランキングに載った日ごとに出る）に、1日で押した印が全部の日に付いてしまう。
 * 「押した日」に紐づけるため、日付と商品コードの組をキーにする。
 */
export function dayItemKey(dateKey, itemCode) {
  return `${dateKey}|${itemCode}`;
}

export const DEFAULT_SETTINGS = {
  // 追加要件v1.3 0章: 3,000のままだとリーチ枠（1,000〜3,000円）が丸ごと落ちる
  minPrice: 1000,
  // 追加要件1章: 500だと定番商品しか残らず顔ぶれが固定化するため200に下げ、
  // 実質の品質判定はレビュー平均で行う
  minReview: 200,
  minReviewAverage: 4.3,
  excludeShippingFeeSeparate: true,
  calendarMode: 'scheduled', // 'scheduled' | 'discovered'
  roomRankBonusRate: 0.02,
  /** カレンダー集計で読み込む日次JSONの最大日数。回線負荷とのトレードオフ */
  calendarWindowDays: 31,
  genreEnabled: {},
  /**
   * おすすめ順に占めるリーチ枠（1,000〜3,000円）の割合（追加要件v1.3 2.4）。
   * **リーチ枠が本当に有利かはまだ実証されていない**（2026/8/19時点の実測では逆の結果）。
   * 検証結果で方針を変える前提なので、コードではなく設定値にしてある。
   */
  reachRatio: 0.7,
};

function emptyState() {
  return {
    version: 1,
    schedule: {},
    comments: {},
    /** 「日付|itemCode」-> true。押した日にだけ付く */
    posted: {},
    /**
     * 予約投稿。投稿文を先に書いておき、投稿予定日に開いてコピペするための目印。
     * 「日付|itemCode」-> { reservedAt, scheduledDate }
     */
    reserved: {},
    /**
     * 投稿の分類（itemCode -> { headerType, criteria[] }）。
     * 外部のAIで作った文章を貼るため、アプリ側では分類が分からない。
     * 分析のために投稿時に選んでもらった内容をここに置く。
     * **角度は廃止した**（追加要件v1.2 1.1）。
     */
    postLabels: {},
    /**
     * 実際に買った商品（itemCode -> true）。追加要件v1.2 3章。
     * 購入済みなら一人称の体験談とオリジナル写真が使えるため、
     * AIへの指示とタグの促しが変わる。買う価値があるかを数字で見るための層でもある。
     */
    purchased: {},
    /**
     * 「スーパーにない」の手動上書き（itemCode -> true/false）。追加要件v1.3 4.3。
     * 自動判定は商品名からの推定なので誤判定が必ず起きる。人の判断を上に置く。
     */
    criteriaOverride: {},
    /**
     * 手動で足した商品（追加要件v1.3 5章）。候補一覧に出てこない商品を投稿したとき、
     * 記録が残らないと分析から漏れる（投稿の全件が揃わないと比率も平均も出せない）。
     */
    manualItems: [],
    /** AI用プロンプトをコピーした商品。投稿ログの usedAiGeneration に使う */
    aiCopied: {},
    posts: [],
    results: [],
    manualSales: [],
    genreRateOverrides: {},
    /** UI から追加したジャンル。config/genres.json に反映するための控え */
    extraGenres: [],
    csvImports: [],
    settings: { ...DEFAULT_SETTINGS },
    meta: { lastExportAt: null, a2hsDismissed: false, firstSeenAt: null, settingsVersion: SETTINGS_VERSION },
  };
}

/** JSTでの日付キー。旧データの移行で postedAt から日付を割り出すのに使う */
function jstDateKeyOf(iso) {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return null;
  return new Date(t + 9 * 3600000).toISOString().slice(0, 10);
}

/**
 * 投稿済みを「日付|itemCode」形式に移行する。
 * 旧データは itemCode だけをキーにしていたので、どの日で押したかを投稿ログから復元する。
 * 投稿ログは「投稿済みにする」で必ず1件作られるため、対応が取れないことは基本的に無い。
 */
function migratePosted(rawPosted, posts) {
  const out = {};
  for (const [key, value] of Object.entries(rawPosted ?? {})) {
    if (!value) continue;
    if (key.includes('|')) {
      out[key] = true;
      continue;
    }
    const post = [...posts].reverse().find((p) => p.itemCode === key);
    const dateKey = post?.dateKey ?? jstDateKeyOf(post?.postedAt);
    // 日付を復元できない場合は捨てずに残す。消すと投稿済みの印が黙って消える
    out[dateKey ? dayItemKey(dateKey, key) : key] = true;
  }
  return out;
}

/** 予約を「日付|itemCode」形式に移行する。旧データは中に scheduledDate を持っている */
function migrateReserved(rawReserved) {
  const out = {};
  for (const [key, value] of Object.entries(rawReserved ?? {})) {
    if (!value) continue;
    if (key.includes('|')) {
      out[key] = value;
      continue;
    }
    const dateKey = value.scheduledDate;
    out[dateKey ? dayItemKey(dateKey, key) : key] = value;
  }
  return out;
}

/** 設定の世代。追加要件v1.1で既定値が変わったため、保存済みの設定を1度だけ移行する */
const SETTINGS_VERSION = 3;

/**
 * 既定値の変更を保存済みの設定に反映する。
 *
 * `load()` は状態を丸ごと保存するため、一度でも起動していれば設定は
 * すべて保存済みになっている。そのままでは DEFAULT_SETTINGS を変えても効かない。
 * **旧既定値のままの項目だけ**を新既定値に差し替える（自分で変えた値は尊重する）。
 */
function migrateSettings(settings, meta) {
  const next = { ...settings };
  if ((meta?.settingsVersion ?? 1) >= SETTINGS_VERSION) return next;

  // 旧既定値 500 のままなら新既定値 200 にする
  if (next.minReview === 500) next.minReview = 200;
  if (typeof next.minReviewAverage !== 'number') next.minReviewAverage = 4.3;
  // v1.3 0章: 下限3,000円はリーチ枠を機械的に落としていた。旧既定値のままなら1,000にする
  if (next.minPrice === 3000) next.minPrice = 1000;
  if (typeof next.reachRatio !== 'number') next.reachRatio = 0.7;
  return next;
}

/**
 * 保存済みの分類を新しい4分類に合わせる。
 *
 * ヘッダー型の名称は v1.2 で総入れ替えになった（状況名指し型・数字型などは廃止）。
 * 古い値が選択欄に残っていると、存在しない選択肢が選ばれた状態になって
 * 何を選んだのか分からなくなる。**対応表は作らず、単に落とす。**
 * 近い名前に読み替えると、分析できない偽のデータになるため。
 */
function migrateLabels(raw) {
  const out = {};
  for (const [code, label] of Object.entries(raw ?? {})) {
    if (!label || typeof label !== 'object') continue;
    const { angle, ...rest } = label; // 角度は廃止
    out[code] = {
      ...rest,
      headerType: HEADER_TYPES.includes(label.headerType) ? label.headerType : null,
    };
  }
  return out;
}

function migrate(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  const posts = Array.isArray(raw.posts) ? raw.posts : [];
  return {
    ...base,
    ...raw,
    settings: migrateSettings({ ...base.settings, ...(raw.settings ?? {}) }, raw.meta),
    meta: { ...base.meta, ...(raw.meta ?? {}), settingsVersion: SETTINGS_VERSION },
    schedule: raw.schedule ?? {},
    comments: raw.comments ?? {},
    posted: migratePosted(raw.posted, posts),
    // 予約投稿は後から足した項目。既存の保存データには入っていない
    reserved: migrateReserved(raw.reserved),
    postLabels: migrateLabels(raw.postLabels),
    purchased: raw.purchased ?? {},
    criteriaOverride: raw.criteriaOverride ?? {},
    manualItems: Array.isArray(raw.manualItems) ? raw.manualItems : [],
    aiCopied: raw.aiCopied ?? {},
    // 分類方式v1（角度あり・7分類）で記録した投稿は名称の対応が取れない。
    // 遡って付け直さず、分析側で外せるように印だけ付ける（追加要件v1.2 1.5）
    posts: posts.map((post) => (post.labelVersion ? post : { ...post, labelVersion: 'v1' })),
    results: Array.isArray(raw.results) ? raw.results : [],
    manualSales: Array.isArray(raw.manualSales) ? raw.manualSales : [],
    genreRateOverrides: raw.genreRateOverrides ?? {},
    extraGenres: Array.isArray(raw.extraGenres) ? raw.extraGenres : [],
    csvImports: Array.isArray(raw.csvImports) ? raw.csvImports : [],
  };
}

let state = emptyState();
let loaded = false;
const listeners = new Set();

export function load() {
  if (loaded) return state;
  try {
    const raw = localStorage.getItem(KEY);
    state = migrate(raw ? JSON.parse(raw) : null);
  } catch (err) {
    console.error('ローカル状態の読み込みに失敗しました。初期状態で続行します', err);
    state = emptyState();
  }
  if (!state.meta.firstSeenAt) state.meta.firstSeenAt = new Date().toISOString();
  loaded = true;
  persist();
  return state;
}

export function getState() {
  return loaded ? state : load();
}

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (err) {
      console.error('ローカル状態の保存に失敗しました', err);
      notifyError?.('保存に失敗しました。設定画面からエクスポートしてください');
    }
  }, 80);
}

let notifyError = null;
export function onPersistError(fn) {
  notifyError = fn;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function update(mutator) {
  const next = getState();
  mutator(next);
  persist();
  for (const fn of listeners) fn(next);
  return next;
}

/* ---------- 個別の操作 ---------- */

/**
 * 投稿予定日の変更。
 * 投稿予定日モードでは商品カードが別の日に移るため、
 * 元の日に付いていた予約・投稿済みの印も一緒に移す（移さないと印が行方不明になる）。
 * 発見日モードで付いた別の日の印はそのまま残す。
 */
export function setScheduledDate(itemCode, dateKey, previousDateKey = null) {
  update((s) => {
    if (dateKey) s.schedule[itemCode] = dateKey;
    else delete s.schedule[itemCode];

    if (!dateKey || !previousDateKey || previousDateKey === dateKey) return;
    const from = dayItemKey(previousDateKey, itemCode);
    const to = dayItemKey(dateKey, itemCode);
    if (s.reserved[from]) {
      s.reserved[to] = { ...s.reserved[from], scheduledDate: dateKey };
      delete s.reserved[from];
    }
    if (s.posted[from]) {
      s.posted[to] = true;
      delete s.posted[from];
    }
  });
}

export function getScheduledDate(itemCode) {
  return getState().schedule[itemCode] ?? null;
}

export function setComment(itemCode, text) {
  update((s) => {
    if (text) s.comments[itemCode] = text;
    else delete s.comments[itemCode];
  });
}

export function getComment(itemCode) {
  return getState().comments[itemCode] ?? null;
}

export function isPosted(dateKey, itemCode) {
  return Boolean(getState().posted[dayItemKey(dateKey, itemCode)]);
}

/**
 * 予約投稿の登録／解除（投稿文を先に書いておき、投稿予定日にコピペするための目印）。
 * 投稿文もここで一緒に保存する。予約したのに本文が残っていない、という状態を作らないため。
 *
 * 投稿文は商品ごとに1つ（日付をまたいで共有する）。同じ商品なら書いた文面は使い回せるため。
 */
export function setReserved(dateKey, itemCode, on, { scheduledDate = null, text = null } = {}) {
  update((s) => {
    const key = dayItemKey(dateKey, itemCode);
    if (!on) {
      delete s.reserved[key];
      return;
    }
    s.reserved[key] = { reservedAt: new Date().toISOString(), scheduledDate: scheduledDate ?? dateKey };
    if (text) s.comments[itemCode] = text;
  });
}

/** 投稿の分類（ヘッダー型・角度・選定基準）を保存する */
/** 投稿の分類を控える。角度は廃止したので受け取らない（追加要件v1.2 1.1） */
export function setPostLabel(itemCode, patch) {
  update((s) => {
    s.postLabels[itemCode] = { ...(s.postLabels[itemCode] ?? {}), ...patch };
  });
}

export function getPostLabel(itemCode) {
  return getState().postLabels[itemCode] ?? {};
}

/**
 * 実際に買った商品の印（追加要件v1.2 3章）。
 *
 * 購入済みなら一人称の体験談が書け、自分で撮った写真も使える。
 * これは「上位と下位の差が最も大きい要因」として実測で挙がっているため、
 * 買う価値があったかを後から数字で確かめられるよう、投稿ログにも残す。
 */
export function setPurchased(itemCode, on) {
  update((s) => {
    if (on) s.purchased[itemCode] = true;
    else delete s.purchased[itemCode];
  });
}

export function isPurchased(itemCode) {
  return Boolean(state.purchased?.[itemCode]);
}

/**
 * いいね数の記録（追加要件v1.2 2.1）。
 *
 * ROOMにAPIはなく画面もJavaScript描画のため自動取得できない。
 * 週1回 my ROOM を見て転記してもらう。
 * **上書きせず履歴として積む。** 投稿直後と1週間後で伸び方が違い、
 * 初速の判定に使うため、いつ測った値かが要る。
 */
export function addLikeCount(postId, count, measuredAt = new Date().toISOString()) {
  update((s) => {
    const post = s.posts.find((p) => p.postId === postId);
    if (!post) return;
    if (!Array.isArray(post.likes)) post.likes = [];
    post.likes.push({ count, measuredAt });
  });
}

/**
 * 「スーパーにない」を手で on/off する（追加要件v1.3 4.3）。
 * 自動判定は商品名からの推定なので、誤判定は必ず起きる。人の判断を上書きとして残す。
 */
export function setCriteriaOverride(itemCode, on) {
  update((s) => {
    if (on === null) delete s.criteriaOverride[itemCode];
    else s.criteriaOverride[itemCode] = on;
  });
}

export function getCriteriaOverride(itemCode) {
  const v = state.criteriaOverride?.[itemCode];
  return v === undefined ? null : v;
}

/** 手動で足した商品を保存する（追加要件v1.3 5章） */
export function addManualItem(item) {
  update((s) => {
    const i = s.manualItems.findIndex((m) => m.itemCode === item.itemCode);
    if (i >= 0) s.manualItems[i] = { ...s.manualItems[i], ...item };
    else s.manualItems.push(item);
  });
}

export function removeManualItem(itemCode) {
  update((s) => {
    s.manualItems = s.manualItems.filter((m) => m.itemCode !== itemCode);
  });
}

/** 直近に測ったいいね数。まだ測っていなければ null */
export function latestLike(post) {
  const likes = Array.isArray(post?.likes) ? post.likes : [];
  if (likes.length === 0) return null;
  return likes.reduce((a, b) => (String(b.measuredAt) >= String(a.measuredAt) ? b : a));
}

/** その日にその商品で作った投稿ログ。いいね数の記録先を引くのに使う */
export function findPost(dateKey, itemCode) {
  const posts = state.posts.filter((p) => p.itemCode === itemCode && (p.dateKey ?? null) === dateKey);
  return posts.length === 0 ? null : posts[posts.length - 1];
}

export function isReserved(dateKey, itemCode) {
  return Boolean(getState().reserved[dayItemKey(dateKey, itemCode)]);
}

/**
 * 商品コードごとの投稿履歴（itemCode -> 押した日の配列）。
 *
 * 投稿済みの印は「押した日」に紐づけているため（同じ商品が複数の日に出るため）、
 * **別の日で同じ商品を見たときに投稿済みだと分からず、二重に投稿してしまう。**
 * それを防ぐために、日をまたいで「この商品はもう投稿した」を引けるようにする。
 */
export function buildPostedItemIndex(posts = getState().posts) {
  const index = new Map();
  for (const post of posts) {
    if (!post?.itemCode) continue;
    // dateKey を持たない古いログは投稿時刻の日付で代用する
    const day = post.dateKey ?? String(post.postedAt ?? '').slice(0, 10);
    const list = index.get(post.itemCode) ?? [];
    if (day && !list.includes(day)) list.push(day);
    index.set(post.itemCode, list);
  }
  for (const list of index.values()) list.sort();
  return index;
}

/** その商品を「この日以外」で投稿済みか。重複投稿の警告に使う */
export function postedOnOtherDays(index, itemCode, dateKey) {
  return (index.get(itemCode) ?? []).filter((day) => day !== dateKey);
}

/**
 * 投稿ログ（仕様書 5.4）。「投稿済みにする」を押した時点で1レコード確定保存する。
 * record.dateKey は押したときに見ていた日。投稿済みの印をその日にだけ付けるために使う。
 */
export function addPost(record) {
  update((s) => {
    const key = dayItemKey(record.dateKey, record.itemCode);
    s.posted[key] = true;
    // 投稿すれば予約は済んだことになる。残すと「予約のみ」に投稿済みが混ざって使えなくなる
    delete s.reserved[key];
    s.posts.push(record);
  });
}

export function undoPost(dateKey, itemCode) {
  update((s) => {
    delete s.posted[dayItemKey(dateKey, itemCode)];
    // 投稿ログは分析の基盤なので消さない。取り消しは最後の1件だけ撤回する
    for (let i = s.posts.length - 1; i >= 0; i -= 1) {
      const post = s.posts[i];
      // dateKey を持たない古いログは商品コードだけで判定する
      if (post.itemCode === itemCode && (post.dateKey === undefined || post.dateKey === dateKey)) {
        s.posts.splice(i, 1);
        break;
      }
    }
  });
}

export function updateSettings(patch) {
  update((s) => Object.assign(s.settings, patch));
}

export function addManualSale(sale) {
  update((s) => s.manualSales.push(sale));
}

export function removeManualSale(id) {
  update((s) => {
    s.manualSales = s.manualSales.filter((x) => x.id !== id);
  });
}

export function setSaleLabel(id, label) {
  update((s) => {
    s.settings.saleLabels = s.settings.saleLabels ?? {};
    if (label) s.settings.saleLabels[id] = label;
    else delete s.settings.saleLabels[id];
  });
}

export function setGenreRateOverride(genreId, rate) {
  update((s) => {
    if (rate === null || rate === undefined) delete s.genreRateOverrides[genreId];
    else s.genreRateOverrides[genreId] = rate;
  });
}

/**
 * 成果データの追加（仕様書 5.5）。
 * occurredAt + itemNameRaw + salesAmount の組で重複判定し、既存を上書き削除しない。
 */
export function mergeResults(rows, sourceLabel) {
  let added = 0;
  let duplicated = 0;
  update((s) => {
    const seen = new Set(s.results.map((r) => `${r.occurredAt}|${r.itemNameRaw}|${r.salesAmount}`));
    for (const row of rows) {
      const key = `${row.occurredAt}|${row.itemNameRaw}|${row.salesAmount}`;
      if (seen.has(key)) {
        duplicated += 1;
        continue;
      }
      seen.add(key);
      s.results.push(row);
      added += 1;
    }
    s.csvImports.push({
      importedAt: new Date().toISOString(),
      source: sourceLabel,
      added,
      duplicated,
      total: rows.length,
    });
  });
  return { added, duplicated, total: rows.length };
}

export function setManualMatch(occurredKey, postId) {
  update((s) => {
    const row = s.results.find((r) => `${r.occurredAt}|${r.itemNameRaw}|${r.salesAmount}` === occurredKey);
    if (row) row.matchedPostId = postId || null;
  });
}

/* ---------- エクスポート／インポート ---------- */

export function exportJson() {
  const s = getState();
  update((x) => {
    x.meta.lastExportAt = new Date().toISOString();
  });
  return JSON.stringify({ exportedAt: new Date().toISOString(), app: 'room-assist', data: s }, null, 2);
}

export function importJson(text) {
  const parsed = JSON.parse(text);
  const data = parsed?.data ?? parsed;
  if (!data || typeof data !== 'object') throw new Error('形式が正しくありません');
  state = migrate(data);
  loaded = true;
  persist();
  for (const fn of listeners) fn(state);
  return state;
}

export function shouldRemindExport(now = new Date()) {
  const s = getState();
  if (s.posts.length === 0 && s.results.length === 0) return false;
  const last = s.meta.lastExportAt ? Date.parse(s.meta.lastExportAt) : null;
  const since = last ?? Date.parse(s.meta.firstSeenAt ?? now.toISOString());
  return now.getTime() - since > EXPORT_REMINDER_DAYS * 86400000;
}

export function clearCache() {
  if (globalThis.caches?.keys) {
    caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
  }
}
