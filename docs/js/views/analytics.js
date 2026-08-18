/**
 * 分析画面（仕様書 8.3 / 10章）。
 *
 * クリック率が測れないため、「投稿した商品のうち何件が売れたか」を成約率とみなす。
 * 投稿数が10件未満の区分は数値を出さず「データ不足」と表示する（10.5）。
 * 報酬は確定／未確定を区別して表示する。
 */

import { app, setAppBar, toast } from '../main.js';
import * as store from '../lib/store.js';
import { matchResults, resultKey } from '../lib/match.js';
import {
  MIN_SAMPLE,
  buildRateSuggestions,
  buildThresholdSuggestions,
  byPurchased,
  latestLikeCount,
  labeledPosts,
  byFirstLineBand,
  byGenre,
  byHourBand,
  bySalePeriod,
  byCriteria,
  byFeatureFlag,
  byHeaderType,
  byLineLengthBand,
  byTotalLengthBand,
  byWeekday,
  filterByPeriod,
  genreRatio,
  KITCHEN_GENRE_ID,
  rateComparison,
  statusOf,
  trafficSummary,
} from '../lib/aggregate.js';
import { escapeHtml, fmtDateTime, fmtNum, fmtPercent, fmtYen } from '../lib/format.js';

let period = 90;
/** 未突合はすべて手動で紐付けられる必要があるため、打ち切らずに追加表示できるようにする（仕様書 10.3） */
const UNMATCHED_PAGE = 50;
let unmatchedVisible = UNMATCHED_PAGE;

/**
 * 集計表。`likes` を立てると平均いいね数の列を足す。
 *
 * いいね数は成果データより早く手に入る（成果は買われるまで出ない）ので、
 * 反応の当たり外れを先に見るための指標として置く（追加要件v1.2 2.3）。
 */
function summaryTable(rows, { label, likes = false }) {
  if (rows.length === 0) return '<p class="empty">データがありません。</p>';
  const body = rows
    .map((row) => {
      const cells = row.enoughSample
        ? `<td>${fmtPercent(row.conversionRate, 1)}</td><td>${fmtYen(row.rewardPerPost)}</td>`
        : `<td colspan="2" class="muted">データ不足（${row.posts}/${MIN_SAMPLE}件）</td>`;
      // 未記録を0として平均すると実態より低く出るため、記録した件数も併記する
      const likeCell = likes
        ? `<td>${row.averageLikes === null ? '<span class="muted">未記録</span>' : `${fmtNum(Math.round(row.averageLikes))}<span class="muted small">（${row.likedPosts}件）</span>`}</td>`
        : '';
      return `<tr><td>${escapeHtml(row.key)}</td><td>${row.posts}</td>${likeCell}<td>${row.convertedPosts}</td>${cells}<td>${fmtYen(row.reward)}</td></tr>`;
    })
    .join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th>${label}</th><th>投稿数</th>${likes ? '<th>平均いいね</th>' : ''}<th>成約</th><th>成約率</th><th>1投稿あたり</th><th>報酬計</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

/**
 * キッチン用品の比率（追加要件 5.1）。
 * 直近30日の投稿に占める割合を出し、30%を超えたら警告する。
 * キッチン用品は耐久財でリピートしないため、食品アカウントの主力にはしない。
 */
function kitchenRatioHtml(allPosts) {
  const r = genreRatio(allPosts, KITCHEN_GENRE_ID, 30);
  if (r.total === 0) {
    return '<p class="small muted">直近30日の投稿がまだありません。キッチン用品の比率はここに出ます。</p>';
  }

  const line = `直近30日の投稿 ${fmtNum(r.total)}件のうち キッチン用品・食器 は <strong>${fmtNum(r.count)}件（${fmtPercent(r.ratio, 1)}）</strong>`;
  return r.overLimit
    ? `<div class="warnbar warnbar--danger">${line}。
        上限の${fmtPercent(r.limit, 0)}を超えています。食品アカウントとしての一貫性が崩れるため、次は食品を優先してください。</div>`
    : `<p class="small muted">${line}（上限 ${fmtPercent(r.limit, 0)}）</p>`;
}

export async function renderAnalytics(root) {
  setAppBar('分析');
  const state = store.getState();

  const posts = filterByPeriod(state.posts, period, 'postedAt');
  const results = filterByPeriod(state.results, period, 'occurredAt');
  const { matched, unmatched, byPostId } = matchResults(state.posts, results);

  const confirmed = results.filter((r) => statusOf(r) === 'confirmed').reduce((s, r) => s + (r.reward ?? 0), 0);
  const pending = results.filter((r) => statusOf(r) === 'pending').reduce((s, r) => s + (r.reward ?? 0), 0);
  const discarded = results.filter((r) => statusOf(r) === 'discarded').length;
  const traffic = trafficSummary(results);
  const comparison = rateComparison(posts, byPostId);
  // 破棄率はジャンル別バケットが持っているので、乖離テーブルに突き合わせて表示する（仕様書 10.4 層3）
  const genreRows = byGenre(posts, byPostId);
  // 1.5: 分類方式v1の投稿は名称の対応が取れないので、分類の層からは外す
  const labeled = labeledPosts(posts);
  // いいね数は成果より早く手に入る指標なので、入れ忘れを分析画面の入口で気づかせる
  const unrecordedLikes = state.posts.filter((p) => latestLikeCount(p) === null).length;
  const labeledNote =
    labeled.length >= MIN_SAMPLE
      ? ''
      : `<div class="warnbar">分類方式v2の投稿が${fmtNum(labeled.length)}件です。
          ${MIN_SAMPLE}件たまるまで成約率と1投稿あたりの数値は出しません（少ない件数では判断を誤るため）。</div>`;

  const genreRates = {};
  for (const dateKey of app.loadedDates) {
    for (const item of app.catalog?.byDiscovered.get(dateKey) ?? []) {
      genreRates[item.genreId] = state.genreRateOverrides[item.genreId] ?? item.genreCommissionRate;
    }
  }
  const rateSuggestions = buildRateSuggestions(comparison, genreRates);
  const thresholdSuggestions = buildThresholdSuggestions(posts, byPostId, state.settings);

  root.innerHTML = `
    <div class="chips">
      ${[30, 90, 0]
        .map((d) => `<button class="chip" data-period="${d}" aria-pressed="${period === d}">${d === 0 ? '全期間' : `${d}日`}</button>`)
        .join('')}
    </div>

    <div class="card">
      <div class="spread"><span>投稿数</span><strong>${fmtNum(posts.length)}</strong></div>
      <div class="spread"><span>成果件数（突合済み ${matched.length} / 未突合 ${unmatched.length}）</span><strong>${fmtNum(results.length)}</strong></div>
      <div class="spread"><span>報酬（確定）</span><strong>${fmtYen(confirmed)}</strong></div>
      <div class="spread"><span>報酬（未確定）</span><strong class="muted">${fmtYen(pending)}</strong></div>
      <div class="spread"><span>破棄（破棄率）</span><strong>${fmtNum(discarded)}件（${fmtPercent(results.length > 0 ? discarded / results.length : null, 1)}）</strong></div>
      <div class="spread"><span>ROOM経由の報酬比率</span><strong>${fmtPercent(traffic.roomRewardRatio, 1)}</strong></div>
    </div>

    ${
      state.results.length === 0
        ? '<div class="warnbar">成果データがありません。設定画面から注文明細レポートのCSVを取り込んでください（ダウンロードはPCからのみ可能です）。</div>'
        : ''
    }

    <div class="card">
      <div class="spread">
        <span class="small">いいね数の記録</span>
        <span class="small ${unrecordedLikes > 0 ? '' : 'muted'}">${unrecordedLikes > 0 ? `未記録 ${fmtNum(unrecordedLikes)}件` : 'すべて記録済み'}</span>
      </div>
      <a class="btn ${unrecordedLikes > 0 ? 'btn--primary' : ''} btn--block" href="#/likes">いいね数をまとめて入れる</a>
    </div>

    <h2>ヘッダー型別（最重要）</h2>
    <p class="small muted" style="margin:0 0 6px">
      投稿時に選んだ冒頭1行の型。<strong>分類方式v2で記録した${fmtNum(labeled.length)}件</strong>だけで集計しています。
      それ以前は角度との2軸で名称も違い、対応が取れないため混ぜていません。
    </p>
    ${labeledNote}
    ${summaryTable(byHeaderType(labeled, byPostId), { label: 'ヘッダー型', likes: true })}

    <h2>購入済みかどうか</h2>
    <p class="small muted" style="margin:0 0 6px">
      購入した商品は一人称の体験談とオリジナル写真が使えます。
      買う価値があるかをここの差で判断してください。
    </p>
    ${summaryTable(byPurchased(labeled, byPostId), { label: '購入', likes: true })}

    <h2>選定基準別</h2>
    <p class="small muted" style="margin:0 0 6px">
      1つの投稿が複数の基準に当てはまるため、基準ごとに同じ投稿を数えています。合計は投稿数と一致しません。
    </p>
    ${summaryTable(byCriteria(labeled, byPostId), { label: '基準' })}

    <h2>ヘッダーの文字数帯</h2>
    ${summaryTable(byFirstLineBand(posts, byPostId), { label: '文字数' })}

    <h2>投稿全体の文字数帯</h2>
    ${summaryTable(byTotalLengthBand(posts, byPostId), { label: '文字数' })}

    <h2>1行あたりの文字数</h2>
    <p class="small muted" style="margin:0 0 6px">上位ほど1行が短いという実測があります（1〜10位で21文字）。</p>
    ${summaryTable(byLineLengthBand(posts, byPostId), { label: '平均' })}

    <h2>文章の作り</h2>
    ${summaryTable(byFeatureFlag(posts, byPostId, 'hasOriginalPhotoTag', 'オリジナル写真'), { label: '写真' })}
    ${summaryTable(byFeatureFlag(posts, byPostId, 'hasCta', 'CTA'), { label: 'CTA' })}
    ${summaryTable(byFeatureFlag(posts, byPostId, 'hasBullets', '箇条書き'), { label: '箇条書き' })}
    ${summaryTable(byFeatureFlag(posts, byPostId, 'hasDivider', '罫線'), { label: '罫線' })}

    <h2>セール期間内外</h2>
    ${summaryTable(bySalePeriod(posts, byPostId, app.sales), { label: '期間' })}

    <h2>曜日別</h2>
    ${summaryTable(byWeekday(posts, byPostId), { label: '曜日' })}

    <h2>投稿時刻帯別</h2>
    ${summaryTable(byHourBand(posts, byPostId), { label: '時刻帯' })}

    <h2>ジャンル別</h2>
    ${kitchenRatioHtml(state.posts)}
    ${summaryTable(genreRows, { label: 'ジャンル' })}

    <h2>デバイス比率</h2>
    ${
      traffic.devices.length === 0
        ? '<p class="empty">データがありません。</p>'
        : `<div class="table-wrap"><table><thead><tr><th>デバイス</th><th>件数</th><th>比率</th></tr></thead><tbody>${traffic.devices
            .map((d) => `<tr><td>${escapeHtml(d.key)}</td><td>${d.count}</td><td>${fmtPercent(d.ratio, 1)}</td></tr>`)
            .join('')}</tbody></table></div>`
    }

    <h2>実料率と想定との乖離</h2>
    ${
      comparison.length === 0
        ? '<p class="empty">データがありません。</p>'
        : `<div class="table-wrap"><table>
            <thead><tr><th>ジャンル</th><th>投稿</th><th>想定報酬</th><th>実報酬</th><th>乖離</th><th>実料率</th><th>破棄率</th></tr></thead>
            <tbody>${comparison
              .map((row) => {
                const bucket = genreRows.find((b) => b.key === row.key);
                return `<tr>
                  <td>${escapeHtml(row.key)}</td>
                  <td>${row.posts}</td>
                  <td>${fmtYen(row.estimatedReward)}</td>
                  <td>${fmtYen(row.actualReward)}</td>
                  <td class="${row.deviation < 0 ? 'muted' : ''}">${row.deviation >= 0 ? '+' : ''}${fmtYen(row.deviation)}</td>
                  <td>${row.actualRate === null ? '—' : `<strong>${fmtPercent(row.actualRate, 2)}</strong>`}</td>
                  <td>${fmtPercent(bucket?.discardRate ?? null, 1)}</td>
                </tr>`;
              })
              .join('')}</tbody></table></div>`
    }

    <h2>抽出条件へのフィードバック</h2>
    ${
      rateSuggestions.length === 0 && thresholdSuggestions.suggestions.length === 0
        ? `<p class="empty">${thresholdSuggestions.enough ? '見直しを提案できる差はありません。' : `成約データが${MIN_SAMPLE}件に届くまで提案しません（少数のデータで条件を固定すると判断を誤るため）。`}</p>`
        : [
            ...rateSuggestions.map(
              (row) => `<div class="card"><div class="spread">
                <span>${escapeHtml(row.key)}: 実料率 <strong>${fmtPercent(row.actualRate, 2)}</strong>（設定 ${fmtPercent(row.current, 2)}）</span>
                <button class="btn" data-apply-rate="${escapeHtml(row.genreId ?? '')}" data-rate="${row.actualRate}">設定に反映</button>
              </div></div>`,
            ),
            ...thresholdSuggestions.suggestions.map(
              (s) => `<div class="card"><div class="spread">
                <span class="small">${escapeHtml(s.message)}</span>
                <button class="btn" data-apply-threshold="${escapeHtml(s.key)}" data-value="${s.value}">適用</button>
              </div></div>`,
            ),
          ].join('')
    }

    <h2>未突合の成果（${unmatched.length}件）</h2>
    <p class="small muted">note等ROOM以外の流入や、過去投稿から遅れて発生した成果が含まれます。自動では捨てません。</p>
    ${
      unmatched.length === 0
        ? '<p class="empty">未突合はありません。</p>'
        : unmatched
            .slice(0, unmatchedVisible)
            .map(
              (row) => `<div class="card">
                <p class="small" style="margin:0 0 6px">${escapeHtml(row.itemNameRaw)}</p>
                <p class="small muted" style="margin:0 0 6px">${fmtDateTime(row.occurredAt)}・${escapeHtml(row.shopName || '—')}・売上 ${fmtYen(row.salesAmount)}・報酬 ${fmtYen(row.reward)}</p>
                <select data-link="${escapeHtml(resultKey(row))}">
                  <option value="">投稿と紐付ける…</option>
                  ${state.posts
                    .map(
                      (p) =>
                        `<option value="${escapeHtml(p.postId)}">${escapeHtml(p.postedAt.slice(0, 10))} ${escapeHtml(p.itemNameRaw.slice(0, 40))}</option>`,
                    )
                    .join('')}
                </select>
              </div>`,
            )
            .join('')
    }
    ${
      unmatched.length > unmatchedVisible
        ? `<button class="btn btn--block" data-more-unmatched>さらに表示（残り${unmatched.length - unmatchedVisible}件）</button>`
        : ''
    }
  `;

  bind(root);
}

function bind(root) {
  root.querySelectorAll('[data-period]').forEach((el) => {
    el.addEventListener('click', () => {
      period = Number(el.dataset.period);
      unmatchedVisible = UNMATCHED_PAGE;
      renderAnalytics(root);
    });
  });

  root.querySelector('[data-more-unmatched]')?.addEventListener('click', () => {
    unmatchedVisible += UNMATCHED_PAGE;
    renderAnalytics(root);
  });

  root.querySelectorAll('[data-link]').forEach((el) => {
    el.addEventListener('change', () => {
      store.setManualMatch(el.dataset.link, el.value);
      toast(el.value ? '投稿と紐付けました' : '紐付けを解除しました');
      renderAnalytics(root);
    });
  });

  root.querySelectorAll('[data-apply-rate]').forEach((el) => {
    el.addEventListener('click', () => {
      store.setGenreRateOverride(el.dataset.applyRate, Number(el.dataset.rate));
      toast('ジャンル料率を実測値で上書きしました');
      renderAnalytics(root);
    });
  });

  root.querySelectorAll('[data-apply-threshold]').forEach((el) => {
    el.addEventListener('click', () => {
      store.updateSettings({ [el.dataset.applyThreshold]: Number(el.dataset.value) });
      toast('抽出条件を更新しました');
      renderAnalytics(root);
    });
  });
}
