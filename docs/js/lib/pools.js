/**
 * 価格帯別の候補プール分割（追加要件v1.3 2章）。
 *
 * **なぜスコアの重み調整で解決しないのか。**
 * 現行の並びは `hotScore + dealScore` の降順で、そこに
 * 「割引率20%以上で+50」という最大の加点がある。そして
 * **割引率が大きいのは高単価商品である**（1,000円が60%OFFになることは稀だが、
 * 10,000円が半額になるのは日常的に起きる）。
 * 重みで比率を作ろうとすると、その日の割引状況で毎回比率が変わり安定しない。
 *
 * そこで**比率を「スコアの結果」ではなく「出力の構造」で担保する。**
 * 価格帯で2つのプールに分け、決めた比率で交互に取り出す。
 */

/** リーチ枠の既定割合。バッチ側の config/scoring.json と同じ値にすること */
export const DEFAULT_REACH_RATIO = 0.7;

/**
 * 商品の価格帯。日次JSONに `priceTier` が入っていればそれを使う。
 * 過去のJSONには無いので、その場合は価格から求める（欠損時は null 扱いという6章の方針）。
 */
export function priceTierOf(item, { reachMin = 1000, reachMax = 3000 } = {}) {
  if (item.priceTier === 'reach' || item.priceTier === 'revenue') return item.priceTier;
  const price = item.hasPriceRange ? item.itemPriceMax : item.itemPrice;
  return price >= reachMin && price <= reachMax ? 'reach' : 'revenue';
}

/**
 * 2つのプールから比率どおりに交互に取り出す。
 *
 * 例）reachRatio 0.7 なら reach, reach, revenue, reach, reach, revenue, ...
 * 実装は「これまでに出したreachの割合が目標を下回っていればreachを出す」だけ。
 * 端数の扱いを場合分けしなくて済み、どこで打ち切っても比率が保たれる。
 */
export function interleaveByRatio(reach, revenue, ratio) {
  const out = [];
  let i = 0;
  let j = 0;
  let reachTaken = 0;

  while (i < reach.length || j < revenue.length) {
    // 一方が尽きたら他方から補充する
    if (i >= reach.length) {
      out.push(revenue[j]);
      j += 1;
      continue;
    }
    if (j >= revenue.length) {
      out.push(reach[i]);
      i += 1;
      reachTaken += 1;
      continue;
    }
    // 出した総数に対する reach の割合が目標未満なら reach を出す
    const wantReach = reachTaken < (out.length + 1) * ratio;
    if (wantReach) {
      out.push(reach[i]);
      i += 1;
      reachTaken += 1;
    } else {
      out.push(revenue[j]);
      j += 1;
    }
  }
  return out;
}

/**
 * 候補を価格帯別に組み直す。
 *
 * @param items 除外条件を通過した候補（すでに hotScore + dealScore 降順である前提）
 * @returns `{ items, reachCount, revenueCount, reachShort }`
 *   `reachShort` はリーチ枠が比率ぶん用意できなかったことを示す。
 *   **UIに「リーチ枠の候補が不足しています」と出すために使う**（2.2 手順5）。
 */
export function buildPools(items, { reachRatio = DEFAULT_REACH_RATIO, reachMin, reachMax } = {}) {
  const reach = [];
  const revenue = [];
  for (const item of items) {
    if (priceTierOf(item, { reachMin, reachMax }) === 'reach') reach.push(item);
    else revenue.push(item);
  }

  // 収益枠の件数から見て、比率どおりなら本来あるべきリーチ枠の件数。
  // これに届かない＝リーチ枠が枯渇していて、収益枠で埋めることになる
  const wanted = revenue.length === 0 ? reach.length : Math.round((revenue.length * reachRatio) / (1 - reachRatio));

  return {
    items: interleaveByRatio(reach, revenue, reachRatio),
    reachCount: reach.length,
    revenueCount: revenue.length,
    reachShort: reach.length < wanted,
    wantedReachCount: wanted,
  };
}
