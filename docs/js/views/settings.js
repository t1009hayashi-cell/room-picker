/**
 * 設定画面（仕様書 8.4）。
 * 対象ジャンル／除外条件の閾値／セール日程／CSVインポート／エクスポート・インポート／キャッシュクリア。
 */

import { app, refreshData, render, setAppBar, toast } from '../main.js';
import * as store from '../lib/store.js';
import { FIELD_LABELS, REQUIRED_FIELDS, buildResults, importCsv } from '../lib/csv.js';
import { loadGenreMaster } from '../lib/dataLoader.js';
import { DEFAULT_COMMISSION_RATE, searchGenres } from '../lib/genres.js';
import { escapeHtml, fmtDateTime, fmtNum, fmtPercent, uuid } from '../lib/format.js';

/** CSVインポートの途中状態（手動マッピング用） */
let pendingCsv = null;

/** ジャンルマスタ（data/genre-master.json）。未取得なら genres: [] */
let genreMaster = { updatedAt: null, maxLevel: 0, genres: [] };

/** 日次バッチを手動実行するためのGitHubの画面 */
const ACTIONS_URL = 'https://github.com/t1009hayashi-cell/room-picker/actions/workflows/daily.yml';

function genreRows() {
  const state = store.getState();
  const found = new Map();
  for (const dateKey of app.loadedDates) {
    for (const item of app.catalog?.byDiscovered.get(dateKey) ?? []) {
      found.set(item.genreId, { genreId: item.genreId, genreName: item.genreName, commissionRate: item.genreCommissionRate });
    }
  }
  for (const extra of state.extraGenres) if (!found.has(extra.genreId)) found.set(extra.genreId, extra);
  return [...found.values()];
}

/**
 * ジャンルの追加欄。
 * マスタがあれば名前で検索して選ぶだけ、無ければ従来どおり genreId を手入力する。
 * マスタは週1回のワークフローで作られるため、初回は存在しない。
 */
function genreSearchHtml() {
  if (genreMaster.genres.length === 0) {
    return `
      <p class="small muted">
        ジャンル一覧がまだありません。GitHubで <code>genre-master</code> を1回実行すると、
        ここで名前を打つだけでジャンルを選べるようになります。
        それまでは番号での追加のみできます。
      </p>
      <div class="row">
        <input type="text" placeholder="genreId" id="new-genre-id" style="flex:1" />
        <input type="text" placeholder="ジャンル名" id="new-genre-name" style="flex:1" />
        <input type="number" placeholder="料率" step="0.005" value="${DEFAULT_COMMISSION_RATE}" id="new-genre-rate" style="width:6.5em" />
      </div>
      <button class="btn btn--block" data-action="add-genre">ジャンルを追加</button>`;
  }

  return `
    <p class="small muted" style="margin:4px 0 6px">
      ジャンル名の一部を入力すると候補が出ます（例: コーヒー）。選ぶだけで番号が入ります。
      全${fmtNum(genreMaster.genres.length)}件・${genreMaster.updatedAt ? escapeHtml(fmtDateTime(genreMaster.updatedAt)) : '取得日時不明'}時点。
    </p>
    <input type="text" placeholder="ジャンル名で検索" id="genre-search" autocomplete="off" />
    <div id="genre-hits"></div>`;
}

export async function renderSettings(root) {
  setAppBar('設定');
  const state = store.getState();
  const s = state.settings;

  // ジャンル一覧は数百件あるので一度だけ読む。未生成でも空で返るため画面は止まらない
  if (genreMaster.genres.length === 0) genreMaster = await loadGenreMaster();

  const genres = genreRows()
    .map((g) => {
      const rate = state.genreRateOverrides[g.genreId] ?? g.commissionRate;
      const enabled = s.genreEnabled?.[g.genreId] !== false;
      return `<div class="card">
        <div class="spread">
          <strong>${escapeHtml(g.genreName)}</strong>
          <label class="small"><input type="checkbox" data-genre-enabled="${escapeHtml(g.genreId)}" ${enabled ? 'checked' : ''} /> 有効</label>
        </div>
        <div class="row small muted">
          <span>genreId: ${escapeHtml(g.genreId)}</span>
          <label>料率 <input type="number" step="0.005" min="0" max="1" value="${rate}" data-genre-rate="${escapeHtml(g.genreId)}" style="width:6.5em" /></label>
          <span>${fmtPercent(rate, 1)}</span>
          ${state.extraGenres.some((x) => x.genreId === g.genreId) ? `<button class="btn" data-genre-remove="${escapeHtml(g.genreId)}">削除</button>` : ''}
        </div>
      </div>`;
    })
    .join('');

  const sales = app.sales
    .map(
      (sale) => `<div class="card">
        <div class="spread">
          <strong>${escapeHtml(sale.displayName ?? sale.name)}</strong>
          <span class="badge">${sale.source === 'manual' ? '手動' : '自動検出'}</span>
        </div>
        <p class="small muted" style="margin:4px 0">${escapeHtml(sale.start.slice(0, 16).replace('T', ' '))} 〜 ${escapeHtml(sale.end.slice(0, 16).replace('T', ' '))}${sale.itemCount ? `・${sale.itemCount}件` : ''}</p>
        <div class="row">
          <input type="text" placeholder="表示名（例: お買い物マラソン）" value="${escapeHtml(state.settings.saleLabels?.[sale.id] ?? sale.userLabel ?? '')}" data-sale-label="${escapeHtml(sale.id)}" style="flex:1" />
          ${sale.source === 'manual' ? `<button class="btn" data-sale-remove="${escapeHtml(sale.id)}">削除</button>` : ''}
        </div>
        ${
          sale.source === 'manual'
            ? `<div class="row" style="margin-top:6px">
                <input type="datetime-local" value="${escapeHtml(sale.start.slice(0, 16))}" data-sale-start="${escapeHtml(sale.id)}" style="flex:1" />
                <input type="datetime-local" value="${escapeHtml(sale.end.slice(0, 16))}" data-sale-end="${escapeHtml(sale.id)}" style="flex:1" />
              </div>`
            : '<p class="small muted" style="margin:4px 0 0">自動検出の期間は編集できません。ずれている場合は手動でセールを追加してください（同じ期間なら手動が優先されます）。</p>'
        }
      </div>`,
    )
    .join('');

  const imports = state.csvImports
    .slice(-5)
    .reverse()
    .map(
      (imp) =>
        `<li>${escapeHtml(fmtDateTime(imp.importedAt))} — ${escapeHtml(imp.source)}：新規${imp.added}件 / 重複${imp.duplicated}件</li>`,
    )
    .join('');

  root.innerHTML = `
    <h2>除外条件の閾値</h2>
    <div class="card">
      <label class="field"><span>価格の下限（円）</span><input type="number" min="0" step="100" value="${s.minPrice}" data-setting="minPrice" /></label>
      <label class="field"><span>レビュー件数の下限</span><input type="number" min="0" step="50" value="${s.minReview}" data-setting="minReview" /></label>
      <label class="small"><input type="checkbox" data-setting-bool="excludeShippingFeeSeparate" ${s.excludeShippingFeeSeparate ? 'checked' : ''} /> 送料別（postageFlag=1）を除外する</label>
      <p class="small muted" style="margin:8px 0 0">在庫なし・価格の期限切れ・定期購入／健康訴求語は必須の除外条件のため、ここでは緩められません。</p>
      <label class="field" style="margin-top:10px"><span>カレンダーで読み込む日数（多いほど通信量が増えます）</span><input type="number" min="1" max="180" value="${s.calendarWindowDays}" data-setting="calendarWindowDays" /></label>
      <label class="field"><span>ROOMランクボーナス率（想定報酬の計算に使用）</span><input type="number" min="0" max="0.1" step="0.005" value="${s.roomRankBonusRate}" data-setting="roomRankBonusRate" /></label>
    </div>

    <h2>対象ジャンル</h2>
    <p class="small muted">
      有効／無効と料率はこのアプリの表示に即座に反映されます。
      日次の取得対象そのものを変えるには、下の「config/genres.json 用のJSONをコピー」で
      設定を書き出してリポジトリの <code>config/genres.json</code> に貼り付けてください
      （<code>enabled: false</code> のジャンルは翌朝から取得されなくなります）。
    </p>
    ${genres || '<p class="empty">データを読み込むと表示されます。</p>'}
    <div class="card">
      <strong class="small">ジャンルを追加</strong>
      ${genreSearchHtml()}
      <button class="btn btn--block" data-action="copy-genres">config/genres.json 用のJSONをコピー</button>
    </div>

    <h2>セール日程</h2>
    ${sales || '<p class="empty">セールがありません。</p>'}
    <div class="card">
      <label class="field"><span>名称</span><input type="text" id="new-sale-name" placeholder="お買い物マラソン" /></label>
      <div class="row">
        <label class="field" style="flex:1"><span>開始</span><input type="datetime-local" id="new-sale-start" /></label>
        <label class="field" style="flex:1"><span>終了</span><input type="datetime-local" id="new-sale-end" /></label>
      </div>
      <p class="small muted" style="margin:0">お買い物マラソンのように 20:00 開始・翌 01:59 終了のセールがあるため、時刻まで指定できます。</p>
      <button class="btn btn--block" data-action="add-sale">セールを追加</button>
    </div>

    <h2>注文明細CSVのインポート</h2>
    <div class="card">
      <p class="small muted">CSVのダウンロードはPCからのみ可能です。取り込んだデータは上書き削除せず蓄積します（成果は6ヶ月前までしか遡れないため）。</p>
      <input type="file" accept=".csv,text/csv" id="csv-file" />
      <div id="csv-result"></div>
      ${imports ? `<p class="small muted" style="margin-top:8px">直近の取り込み</p><ul class="small muted" style="padding-left:1.2em">${imports}</ul>` : ''}
      <p class="small muted">保持中の成果データ: ${fmtNum(state.results.length)}件 / 投稿ログ: ${fmtNum(state.posts.length)}件</p>
    </div>

    <h2>データのエクスポート／インポート</h2>
    <div class="card">
      <p class="small muted">iOSはSafariのストレージを削除することがあります。月1回を目安にエクスポートしてください。最終エクスポート: ${state.meta.lastExportAt ? escapeHtml(fmtDateTime(state.meta.lastExportAt)) : 'まだ実行していません'}</p>
      <button class="btn btn--block btn--primary" data-action="export">JSONをエクスポート</button>
      <input type="file" accept="application/json,.json" id="import-file" style="margin-top:8px" />
    </div>

    <h2>データの更新</h2>
    <div class="card">
      <p class="small">
        商品データは<strong>毎朝6時ごろ</strong>に自動で作られます（7時・8時にも取りこぼしの確認をします）。
        ただし自動実行は混雑で数時間遅れることがあります。
      </p>
      <p class="small muted">
        いま読み込んでいるデータ: <strong>${app.loadedDates.at(-1) ?? '—'}</strong>（${fmtNum(app.loadedDates.length)}日分）
      </p>
      <p class="small muted" style="margin-bottom:6px">
        待てないときは下のボタンでGitHubの画面を開き、「Run workflow」を押すと2〜3分で作られます。
        できあがったら「最新のデータを読み込む」を押してください。
      </p>
      <a class="btn btn--block" href="${ACTIONS_URL}" target="_blank" rel="noopener noreferrer">GitHubで今すぐ取得する</a>
      <button class="btn btn--block btn--primary" data-action="reload-data">最新のデータを読み込む</button>
    </div>

    <h2>キャッシュ</h2>
    <div class="card">
      <p class="small muted">日次JSONのキャッシュを消して読み直します。ローカルに保存した投稿ログ・設定は消えません。</p>
      <button class="btn btn--block" data-action="clear-cache">キャッシュをクリアして再読み込み</button>
    </div>
  `;

  bind(root);
}

function renderCsvResult(root, parsed) {
  const box = root.querySelector('#csv-result');
  if (!parsed) {
    box.innerHTML = '';
    return;
  }

  const options = (selected) =>
    ['<option value="">（未指定）</option>']
      .concat(
        parsed.headers.map(
          (h, i) => `<option value="${i}" ${selected === i ? 'selected' : ''}>${escapeHtml(h || `列${i + 1}`)}</option>`,
        ),
      )
      .join('');

  const mappingRows = Object.keys(FIELD_LABELS)
    .map(
      (field) => `<label class="field">
        <span>${FIELD_LABELS[field]}${REQUIRED_FIELDS.includes(field) ? '（必須）' : ''}</span>
        <select data-map="${field}">${options(parsed.mapping[field])}</select>
      </label>`,
    )
    .join('');

  box.innerHTML = `
    <p class="small" style="margin-top:8px">文字コード: <strong>${escapeHtml(parsed.encoding)}</strong> / ${parsed.rows.length - 1}行</p>
    ${parsed.warnings.map((w) => `<div class="warnbar">${escapeHtml(w)}</div>`).join('')}
    <details ${parsed.missing.length > 0 ? 'open' : ''}>
      <summary>列のマッピングを確認・修正する</summary>
      ${mappingRows}
    </details>
    <p class="small muted">読み取れた成果: ${parsed.results.length}件</p>
    <button class="btn btn--primary btn--block" data-action="csv-commit" ${parsed.results.length === 0 ? 'disabled' : ''}>この内容で取り込む</button>
  `;

  box.querySelectorAll('[data-map]').forEach((el) => {
    el.addEventListener('change', () => {
      const field = el.dataset.map;
      if (el.value === '') delete pendingCsv.mapping[field];
      else pendingCsv.mapping[field] = Number(el.value);
      const rebuilt = buildResults(pendingCsv.rows, pendingCsv.mapping);
      pendingCsv = { ...pendingCsv, ...rebuilt };
      renderCsvResult(root, pendingCsv);
    });
  });
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 検索結果の描画。すでに追加済みのジャンルは、押せない状態にして重複追加を防ぐ */
function renderGenreHits(root, query) {
  const box = root.querySelector('#genre-hits');
  if (!box) return;

  const hits = searchGenres(genreMaster.genres, query);
  if (query.trim() === '') {
    box.innerHTML = '';
    return;
  }
  if (hits.length === 0) {
    box.innerHTML = '<p class="small muted" style="margin:6px 0 0">該当するジャンルがありません。</p>';
    return;
  }

  const existing = new Set(genreRows().map((g) => String(g.genreId)));
  box.innerHTML = hits
    .map((g) => {
      const added = existing.has(String(g.genreId));
      // ボタンの幅は固定にする。「追加」と「追加済み」で文字数が違うため、
      // 成り行きにすると行ごとに大きさがばらついて押しにくい
      return `<div class="genre-hit">
        <span class="genre-hit__name">${escapeHtml(g.path)}<span class="muted"> / ${escapeHtml(g.genreId)}</span></span>
        <button class="btn genre-hit__btn ${added ? '' : 'btn--primary'}" data-genre-add="${escapeHtml(g.genreId)}" ${added ? 'disabled' : ''}>${added ? '追加済み' : '追加'}</button>
      </div>`;
    })
    .join('');

  box.querySelectorAll('[data-genre-add]').forEach((el) => {
    el.addEventListener('click', () => {
      const genre = genreMaster.genres.find((g) => String(g.genreId) === el.dataset.genreAdd);
      if (!genre) return;
      store.update((s) =>
        s.extraGenres.push({
          genreId: String(genre.genreId),
          genreName: genre.genreName,
          // 料率はジャンル検索APIから取れない。API が返す商品ごとの実料率が優先される（仕様書4.4）
          commissionRate: DEFAULT_COMMISSION_RATE,
          enabled: true,
        }),
      );
      toast(`${genre.genreName} を追加しました。取得対象にするには下のJSONコピーが必要です`);
      renderSettings(root);
    });
  });
}

function bind(root) {
  const search = root.querySelector('#genre-search');
  if (search) {
    search.addEventListener('input', () => renderGenreHits(root, search.value));
  }

  root.querySelectorAll('[data-setting]').forEach((el) => {
    el.addEventListener('change', async () => {
      const value = Number(el.value);
      if (!Number.isFinite(value)) return;
      store.updateSettings({ [el.dataset.setting]: value });
      await refreshData();
      toast('設定を保存しました');
      renderSettings(root);
    });
  });

  root.querySelectorAll('[data-setting-bool]').forEach((el) => {
    el.addEventListener('change', async () => {
      store.updateSettings({ [el.dataset.settingBool]: el.checked });
      await refreshData();
      toast('設定を保存しました');
      renderSettings(root);
    });
  });

  root.querySelectorAll('[data-genre-enabled]').forEach((el) => {
    el.addEventListener('change', async () => {
      const id = el.dataset.genreEnabled;
      store.update((s) => {
        s.settings.genreEnabled = s.settings.genreEnabled ?? {};
        s.settings.genreEnabled[id] = el.checked;
      });
      await refreshData();
      toast('ジャンルの表示を切り替えました');
      renderSettings(root);
    });
  });

  root.querySelectorAll('[data-genre-rate]').forEach((el) => {
    el.addEventListener('change', () => {
      store.setGenreRateOverride(el.dataset.genreRate, Number(el.value));
      toast('料率を保存しました');
      renderSettings(root);
    });
  });

  root.querySelectorAll('[data-genre-remove]').forEach((el) => {
    el.addEventListener('click', () => {
      store.update((s) => {
        s.extraGenres = s.extraGenres.filter((g) => g.genreId !== el.dataset.genreRemove);
      });
      renderSettings(root);
    });
  });

  root.querySelectorAll('[data-sale-label]').forEach((el) => {
    el.addEventListener('change', async () => {
      store.setSaleLabel(el.dataset.saleLabel, el.value.trim());
      await refreshData();
      toast('表示名を保存しました');
      renderSettings(root);
    });
  });

  const editSaleDate = (el, field, toIso) => {
    el.addEventListener('change', async () => {
      const id = el.dataset[field];
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(el.value)) return;
      const sale = store.getState().manualSales.find((s) => s.id === id);
      if (!sale) return;
      const next = { ...sale, [field === 'saleStart' ? 'start' : 'end']: toIso(el.value) };
      if (Date.parse(next.start) > Date.parse(next.end)) {
        toast('終了日は開始日以降にしてください');
        renderSettings(root);
        return;
      }
      store.update((s) => {
        const target = s.manualSales.find((x) => x.id === id);
        if (target) Object.assign(target, next);
      });
      await refreshData();
      toast('セール期間を更新しました');
      renderSettings(root);
    });
  };
  // 入力値は JST の壁時計時刻として扱う（アプリ全体を JST 固定にしているため）
  const toJstIso = (value) => `${value}:00+09:00`;
  root.querySelectorAll('[data-sale-start]').forEach((el) => editSaleDate(el, 'saleStart', toJstIso));
  root.querySelectorAll('[data-sale-end]').forEach((el) => editSaleDate(el, 'saleEnd', toJstIso));

  root.querySelectorAll('[data-sale-remove]').forEach((el) => {
    el.addEventListener('click', async () => {
      store.removeManualSale(el.dataset.saleRemove);
      await refreshData();
      renderSettings(root);
    });
  });

  root.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;

    if (action === 'add-genre') {
      // ジャンルマスタがある場合は名前検索に置き換わっており、この入力欄は存在しない
      const idEl = root.querySelector('#new-genre-id');
      if (!idEl) return;
      const genreId = idEl.value.trim();
      const genreName = root.querySelector('#new-genre-name').value.trim();
      const commissionRate = Number(root.querySelector('#new-genre-rate').value);
      if (!genreId || !genreName) return toast('genreId とジャンル名を入力してください');
      store.update((s) => s.extraGenres.push({ genreId, genreName, commissionRate, enabled: true }));
      renderSettings(root);
    } else if (action === 'copy-genres') {
      const state = store.getState();
      const json = JSON.stringify(
        {
          genres: genreRows().map((g) => ({
            genreId: g.genreId,
            genreName: g.genreName,
            commissionRate: state.genreRateOverrides[g.genreId] ?? g.commissionRate,
            enabled: state.settings.genreEnabled?.[g.genreId] !== false,
          })),
        },
        null,
        2,
      );
      await navigator.clipboard?.writeText(json).catch(() => {});
      toast('config/genres.json 用のJSONをコピーしました');
    } else if (action === 'add-sale') {
      const name = root.querySelector('#new-sale-name').value.trim();
      const start = root.querySelector('#new-sale-start').value;
      const end = root.querySelector('#new-sale-end').value;
      if (!name || !start || !end) return toast('名称・開始日時・終了日時を入力してください');
      if (start >= end) return toast('終了日時は開始日時より後にしてください');
      store.addManualSale({
        id: `manual-${uuid()}`,
        name,
        start: `${start}:00+09:00`,
        end: `${end}:00+09:00`,
        itemCount: 0,
        source: 'manual',
        userLabel: name,
      });
      await refreshData();
      toast('セールを追加しました');
      renderSettings(root);
    } else if (action === 'csv-commit') {
      if (!pendingCsv || pendingCsv.results.length === 0) return;
      const summary = store.mergeResults(pendingCsv.results, pendingCsv.fileName ?? 'CSV');
      pendingCsv = null;
      toast(`取り込みました: 新規${summary.added}件 / 重複${summary.duplicated}件`);
      renderSettings(root);
    } else if (action === 'export') {
      download(`room-assist-${new Date().toISOString().slice(0, 10)}.json`, store.exportJson());
      toast('エクスポートしました');
    } else if (action === 'reload-data') {
      // 取得が終わったばかりの新しい日付を拾うため、キャッシュを捨てて index.json から読み直す
      const before = app.loadedDates.at(-1) ?? null;
      await refreshData({ force: true });
      const after = app.loadedDates.at(-1) ?? null;
      toast(after && after !== before ? `${after} のデータを読み込みました` : `新しいデータはまだありません（最新: ${after ?? '—'}）`);
      renderSettings(root);
    } else if (action === 'clear-cache') {
      store.clearCache();
      await refreshData({ force: true });
      toast('キャッシュをクリアしました');
      render();
    }
  });

  root.querySelector('#csv-file')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = importCsv(await file.arrayBuffer());
      pendingCsv = { ...parsed, fileName: file.name };
      renderCsvResult(root, pendingCsv);
    } catch (err) {
      console.error(err);
      toast(`CSVを読めませんでした: ${err.message}`);
    }
  });

  root.querySelector('#import-file')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!confirm('現在のローカルデータを、選択したファイルの内容で置き換えます。よろしいですか？')) return;
    try {
      store.importJson(await file.text());
      await refreshData();
      toast('インポートしました');
      renderSettings(root);
    } catch (err) {
      console.error(err);
      toast(`インポートに失敗しました: ${err.message}`);
    }
  });
}
