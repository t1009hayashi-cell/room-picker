/**
 * 集計指標（仕様書 10.4 / 10.5）。
 *
 * クリック率が測れないため、「投稿した商品のうち何件が売れたか」を成約率とみなす。
 * 投稿数が MIN_SAMPLE 未満の区分は数値を出さず「データ不足」とする（10.5）。
 * 報酬は確定前の値を含むため、確定／未確定を区別して持つ。
 */

import { firstLineBand, jstParts } from './format.js';
import { lineLengthBand, totalLengthBand } from './postFeatures.js';
import { isDuringSale } from './schedule.js';

export const MIN_SAMPLE = 10;
const CONFIRMED_WORDS = ['確定'];
const DISCARDED_WORDS = ['破棄', 'キャンセル', '取消'];

export function statusOf(result) {
  const s = String(result.status ?? '');
  if (DISCARDED_WORDS.some((w) => s.includes(w))) return 'discarded';
  if (s.includes('未確定')) return 'pending';
  if (CONFIRMED_WORDS.some((w) => s.includes(w))) return 'confirmed';
  return 'unknown';
}

export function isRoomTraffic(result) {
  return String(result.trackingId ?? '').includes('ROOM');
}

function emptyBucket(key) {
  return {
    key,
    posts: 0,
    convertedPosts: 0,
    orders: 0,
    salesAmount: 0,
    reward: 0,
    rewardConfirmed: 0,
    rewardPending: 0,
    discarded: 0,
    /** いいね数を記録できている投稿だけの合計。未記録は分母に入れない（2.3） */
    likeSum: 0,
    likedPosts: 0,
  };
}

/** 直近に測ったいいね数。未記録なら null */
export function latestLikeCount(post) {
  const likes = Array.isArray(post?.likes) ? post.likes : [];
  if (likes.length === 0) return null;
  const latest = likes.reduce((a, b) => (String(b.measuredAt) >= String(a.measuredAt) ? b : a));
  return Number.isFinite(latest?.count) ? latest.count : null;
}

function addResultTo(bucket, result) {
  const status = statusOf(result);
  bucket.orders += 1;
  bucket.salesAmount += result.salesAmount ?? 0;
  if (status === 'discarded') {
    bucket.discarded += 1;
    return;
  }
  bucket.reward += result.reward ?? 0;
  if (status === 'confirmed') bucket.rewardConfirmed += result.reward ?? 0;
  else bucket.rewardPending += result.reward ?? 0;
}

/** 投稿を任意のキーでグルーピングして集計する共通処理 */
export function summarize(posts, byPostId, keyOf) {
  const buckets = new Map();
  for (const post of posts) {
    const keys = keyOf(post);
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (key === null || key === undefined) continue;
      if (!buckets.has(key)) buckets.set(key, emptyBucket(key));
      const bucket = buckets.get(key);
      bucket.posts += 1;
      const likes = latestLikeCount(post);
      if (likes !== null) {
        bucket.likeSum += likes;
        bucket.likedPosts += 1;
      }
      const results = byPostId.get(post.postId) ?? [];
      if (results.length > 0) bucket.convertedPosts += 1;
      for (const result of results) addResultTo(bucket, result);
    }
  }
  return [...buckets.values()].map(finalize).sort((a, b) => b.posts - a.posts);
}

function finalize(bucket) {
  const enough = bucket.posts >= MIN_SAMPLE;
  return {
    ...bucket,
    enoughSample: enough,
    conversionRate: enough ? bucket.convertedPosts / bucket.posts : null,
    /** 平均いいね数。**いいねを記録した投稿だけ**で割る（未記録を0とみなさない） */
    averageLikes: bucket.likedPosts === 0 ? null : bucket.likeSum / bucket.likedPosts,
    rewardPerPost: enough ? bucket.reward / bucket.posts : null,
    discardRate: bucket.orders > 0 ? bucket.discarded / bucket.orders : null,
    actualRate: bucket.salesAmount > 0 ? bucket.reward / bucket.salesAmount : null,
  };
}

/**
 * 分類方式v2で記録した投稿だけを取り出す（追加要件v1.2 1.5）。
 *
 * v1は「角度」との2軸で、ヘッダー型の名称も今と違う（状況名指し型・数字型など）。
 * 名称の対応が取れないうえ47件中27件が空欄のため、**混ぜずに切り捨てる。**
 * 近い名前に読み替えると分析できない偽のデータになる。
 */
export function labeledPosts(posts) {
  return posts.filter((post) => post.labelVersion === 'v2');
}

/**
 * 手動追加した投稿を除く（追加要件v1.3 5.5）。
 *
 * 価格帯比率の集計には**含める**（手動追加が高単価に偏っていれば、それも実態）。
 * 一方で手入力分はデータの質が違うので、選定ロジックを見るときは外せるようにする。
 */
export function excludeManualPosts(posts) {
  return posts.filter((post) => (post.itemSource ?? 'ranking') !== 'manual');
}

/** 価格帯別（追加要件v1.3 2章）。リーチ枠と収益枠のどちらが伸びているかを見る */
export function byPriceTier(posts, byPostId) {
  return summarize(posts, byPostId, (post) => {
    if (post.priceTier === 'reach') return 'リーチ枠（1,000〜3,000円）';
    if (post.priceTier === 'revenue') return '収益枠（3,000円超）';
    return '（記録なし）';
  });
}

/** 購入済み／未購入で分ける。買う価値があるかを数字で見るための層（3章） */
export function byPurchased(posts, byPostId) {
  return summarize(posts, byPostId, (post) => (post.purchased ? '購入済み' : '未購入'));
}

/** 層1：1行目の文字数帯 */
export function byFirstLineBand(posts, byPostId) {
  return summarize(posts, byPostId, (post) => firstLineBand(post.firstLineLength ?? 0));
}

/* ---------- 実際に投稿した文章から測った層（投稿プロンプトの実測項目に対応） ---------- */

const UNSET = '（未設定）';

/** ヘッダー型別。実測では共感課題型・状況名指し型が上位に多いとされている */
export function byHeaderType(posts, byPostId) {
  return summarize(posts, byPostId, (post) => post.headerType ?? UNSET);
}

/**
 * 選定基準別。1投稿が複数の基準に当てはまるため、**基準ごとに同じ投稿を数える**。
 * 合計が投稿数と一致しないのは意図どおり。
 */
export function byCriteria(posts, byPostId) {
  const rows = [];
  const all = new Set();
  for (const post of posts) for (const c of post.criteria ?? []) all.add(c);

  for (const criterion of [...all].sort()) {
    const subset = posts.filter((p) => (p.criteria ?? []).includes(criterion));
    rows.push(...summarize(subset, byPostId, () => criterion));
  }
  const none = posts.filter((p) => (p.criteria ?? []).length === 0);
  if (none.length > 0) rows.push(...summarize(none, byPostId, () => UNSET));
  return rows;
}

/** 投稿全体の文字数帯。ROOMの上限は500文字 */
export function byTotalLengthBand(posts, byPostId) {
  return summarize(posts, byPostId, (post) =>
    post.features ? totalLengthBand(post.features.totalLength) : UNSET,
  );
}

/** 1行あたりの平均文字数帯。上位ほど1行が短いという実測がある */
export function byLineLengthBand(posts, byPostId) {
  return summarize(posts, byPostId, (post) =>
    post.features ? lineLengthBand(post.features.averageLineLength) : UNSET,
  );
}

/** 文章の作りの有無で比べる（CTA・箇条書き・罫線・オリジナル写真） */
export function byFeatureFlag(posts, byPostId, flag, label) {
  return summarize(posts, byPostId, (post) => {
    if (!post.features) return UNSET;
    return post.features[flag] ? `${label}あり` : `${label}なし`;
  });
}

/** 層2：セール期間内外 */
export function bySalePeriod(posts, byPostId, sales) {
  return summarize(posts, byPostId, (post) => {
    const during = post.duringSale ?? isDuringSale(sales, post.postedAt).during;
    return during ? 'セール期間内' : 'セール期間外';
  });
}

const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土'];

// 曜日・時刻帯は端末のタイムゾーンではなく JST で分ける。
// getDay()/getHours() を使うと、海外や設定変更時に集計がずれる。
export function byWeekday(posts, byPostId) {
  return summarize(posts, byPostId, (post) => {
    const parts = jstParts(post.postedAt);
    return parts ? `${WEEKDAY[parts.dow]}曜` : null;
  });
}

export function byHourBand(posts, byPostId) {
  return summarize(posts, byPostId, (post) => {
    const parts = jstParts(post.postedAt);
    if (!parts) return null;
    if (parts.hour < 6) return '0-5時';
    if (parts.hour < 12) return '6-11時';
    if (parts.hour < 18) return '12-17時';
    return '18-23時';
  });
}

/** 層3：ジャンル別 */
export function byGenre(posts, byPostId) {
  return summarize(posts, byPostId, (post) => post.genreName ?? '（不明）');
}

/** 層3：実料率と想定との乖離 */
export function rateComparison(posts, byPostId) {
  const rows = new Map();
  for (const post of posts) {
    const key = post.genreName ?? '（不明）';
    if (!rows.has(key)) {
      rows.set(key, { key, genreId: post.genreId, posts: 0, estimatedReward: 0, actualReward: 0, salesAmount: 0 });
    }
    const row = rows.get(key);
    row.posts += 1;
    row.estimatedReward += post.estimatedReward ?? 0;
    for (const result of byPostId.get(post.postId) ?? []) {
      if (statusOf(result) === 'discarded') continue;
      row.actualReward += result.reward ?? 0;
      row.salesAmount += result.salesAmount ?? 0;
    }
  }
  return [...rows.values()]
    .map((row) => ({
      ...row,
      actualRate: row.salesAmount > 0 ? row.actualReward / row.salesAmount : null,
      deviation: row.actualReward - row.estimatedReward,
    }))
    .sort((a, b) => b.posts - a.posts);
}

/** デバイス比率と ROOM 経由比率 */
export function trafficSummary(results) {
  const devices = new Map();
  let roomReward = 0;
  let allReward = 0;

  for (const result of results) {
    if (statusOf(result) === 'discarded') continue;
    const device = result.deviceType || '不明';
    devices.set(device, (devices.get(device) ?? 0) + 1);
    allReward += result.reward ?? 0;
    if (isRoomTraffic(result)) roomReward += result.reward ?? 0;
  }

  const total = [...devices.values()].reduce((a, b) => a + b, 0);
  return {
    devices: [...devices.entries()]
      .map(([key, count]) => ({ key, count, ratio: total > 0 ? count / total : 0 }))
      .sort((a, b) => b.count - a.count),
    roomRewardRatio: allReward > 0 ? roomReward / allReward : null,
    roomReward,
    allReward,
  };
}

/** 期間セレクタ（30日／90日／全期間） */
export function filterByPeriod(items, days, field, now = new Date()) {
  if (!days) return items;
  const from = now.getTime() - days * 86400000;
  return items.filter((item) => {
    const t = Date.parse(item[field]);
    return Number.isNaN(t) ? false : t >= from;
  });
}

/**
 * Phase 5: 実料率を根拠に、ジャンル設定の料率を更新する提案を作る。
 * サンプルが少ないうちは提案しない（10.5 と同じ理由）。
 */
/**
 * ジャンルの偏りを見る（追加要件 5.1）。
 *
 * キッチン用品は耐久財でリピートしないため主力にしない。
 * **食品アカウントとしての一貫性を保つため、直近の投稿に占める比率が上限を超えたら警告する。**
 */
export const KITCHEN_GENRE_ID = '558944';
export const KITCHEN_RATIO_LIMIT = 0.3;

export function genreRatio(posts, genreId, days = 30, now = new Date()) {
  const recent = filterByPeriod(posts, days, 'postedAt', now);
  const total = recent.length;
  const count = recent.filter((post) => String(post.genreId) === String(genreId)).length;
  return {
    days,
    total,
    count,
    // 0件のときは比率を出さない（0%と表示すると「問題なし」に見えてしまう）
    ratio: total === 0 ? null : count / total,
    limit: KITCHEN_RATIO_LIMIT,
    overLimit: total > 0 && count / total > KITCHEN_RATIO_LIMIT,
  };
}

export function buildRateSuggestions(comparison, currentRates) {
  return comparison
    .filter((row) => row.actualRate !== null && row.posts >= MIN_SAMPLE && row.salesAmount > 0)
    .map((row) => {
      const current = currentRates[row.genreId] ?? null;
      const diff = current === null ? null : row.actualRate - current;
      return { ...row, current, diff, significant: diff !== null && Math.abs(diff) >= 0.005 };
    })
    .filter((row) => row.significant);
}

/**
 * Phase 5: 除外条件の見直し提案。
 * 「除外された価格帯から成果が出ている」など、閾値が機会損失になっている兆候を出す。
 */
export function buildThresholdSuggestions(posts, byPostId, settings) {
  const converted = posts.filter((p) => (byPostId.get(p.postId) ?? []).length > 0);
  if (converted.length < MIN_SAMPLE) {
    return { enough: false, suggestions: [] };
  }

  const suggestions = [];
  const prices = converted.map((p) => p.itemPrice ?? 0).sort((a, b) => a - b);
  const p10 = prices[Math.floor(prices.length * 0.1)] ?? 0;
  if (p10 > 0 && p10 > settings.minPrice * 1.5) {
    suggestions.push({
      key: 'minPrice',
      message: `成約した投稿の下位10%でも${Math.round(p10).toLocaleString('ja-JP')}円です。価格の下限を${Math.round(p10 / 500) * 500}円まで上げると候補を絞れます`,
      value: Math.round(p10 / 500) * 500,
    });
  }

  const lowReview = converted.filter((p) => (p.reviewCount ?? 0) < settings.minReview).length;
  if (lowReview / converted.length >= 0.2) {
    suggestions.push({
      key: 'minReview',
      message: `成約した投稿の${Math.round((lowReview / converted.length) * 100)}%はレビュー${settings.minReview}件未満の商品です。下限を下げると候補が増えます`,
      value: Math.max(100, Math.round(settings.minReview / 2)),
    });
  }

  return { enough: true, suggestions };
}
