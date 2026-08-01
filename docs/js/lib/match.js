/**
 * 投稿ログと成果データの突合（仕様書 10.3）。
 *
 *  - itemNameRaw の完全一致で突合する
 *  - 一致しない場合、ショップ名一致 + 商品名の前方一致（30文字）でフォールバック
 *  - それでも一致しない成果は matchedPostId: null のまま「未突合」として残す
 *  - 未突合を自動で捨てない（note等ROOM以外の流入、過去投稿からの遅れた成果が含まれるため）
 *  - 同一商品を複数回投稿している場合は、成果発生日時に最も近い直前の投稿に紐付ける
 */

const PREFIX_LENGTH = 30;

function prefix(text) {
  return Array.from(String(text ?? '')).slice(0, PREFIX_LENGTH).join('');
}

/** 成果発生日時に最も近い「直前の」投稿を選ぶ。直前が無ければ最も近い投稿にフォールバックする */
function pickNearestPost(posts, occurredAt) {
  const t = Date.parse(occurredAt);
  if (Number.isNaN(t) || posts.length === 0) return posts[0] ?? null;

  const before = posts
    .filter((p) => Date.parse(p.postedAt) <= t)
    .sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt));
  if (before.length > 0) return before[0];

  return [...posts].sort((a, b) => Math.abs(Date.parse(a.postedAt) - t) - Math.abs(Date.parse(b.postedAt) - t))[0];
}

/**
 * @returns {{matched: Array, unmatched: Array, byPostId: Map<string, Array>}}
 */
export function matchResults(posts, results) {
  const exact = new Map();
  const byShopPrefix = new Map();

  for (const post of posts) {
    const nameKey = post.itemNameRaw ?? '';
    if (!exact.has(nameKey)) exact.set(nameKey, []);
    exact.get(nameKey).push(post);

    const shopKey = `${post.shopName ?? ''}|${prefix(nameKey)}`;
    if (!byShopPrefix.has(shopKey)) byShopPrefix.set(shopKey, []);
    byShopPrefix.get(shopKey).push(post);
  }

  const matched = [];
  const unmatched = [];
  const byPostId = new Map();

  for (const result of results) {
    // 手動で紐付け済みならそれを尊重する
    if (result.matchedPostId) {
      const post = posts.find((p) => p.postId === result.matchedPostId);
      if (post) {
        matched.push({ result, post, method: 'manual' });
        if (!byPostId.has(post.postId)) byPostId.set(post.postId, []);
        byPostId.get(post.postId).push(result);
        continue;
      }
    }

    let candidates = exact.get(result.itemNameRaw) ?? [];
    let method = 'exact';
    if (candidates.length === 0) {
      candidates = byShopPrefix.get(`${result.shopName ?? ''}|${prefix(result.itemNameRaw)}`) ?? [];
      method = 'prefix';
    }

    if (candidates.length === 0) {
      unmatched.push(result);
      continue;
    }

    const post = pickNearestPost(candidates, result.occurredAt);
    if (!post) {
      unmatched.push(result);
      continue;
    }
    matched.push({ result, post, method });
    if (!byPostId.has(post.postId)) byPostId.set(post.postId, []);
    byPostId.get(post.postId).push(result);
  }

  return { matched, unmatched, byPostId };
}

export function resultKey(result) {
  return `${result.occurredAt}|${result.itemNameRaw}|${result.salesAmount}`;
}
