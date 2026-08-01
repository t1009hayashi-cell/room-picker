/**
 * 注文明細レポートCSVの取り込み（仕様書 10.2）。
 *
 *  - 文字コードは Shift_JIS の可能性があるため、UTF-8 と Shift_JIS の両方を試行する
 *  - 列構成は変更されうるため、ヘッダ行を読んで列名でマッピングする。列位置の決め打ちは禁止
 *  - 列名が想定と異なる場合はエラーで落とさず、警告を出して手動マッピングできるようにする
 *
 * 実ファイルの列名は未確認のため、候補を複数持ち、一致しなければ未マッピングとして返す。
 */

/** 論理フィールド → 実CSVの列名候補（前方一致でなく正規化後の完全一致・部分一致で照合） */
export const FIELD_CANDIDATES = {
  occurredAt: ['注文日時', '注文日', '発生日時', '発生日', '成果発生日', '日時', 'クリック日時'],
  itemNameRaw: ['商品名', '商品', '商品名称'],
  shopName: ['ショップ名', '店舗名', 'ショップ', '店舗'],
  genreName: ['ジャンル名', 'ジャンル', 'カテゴリ'],
  salesAmount: ['売上金額', '注文金額', '商品価格', '売上', '金額'],
  reward: ['報酬額', '成果報酬', '報酬金額', '報酬'],
  rate: ['料率', '報酬料率', 'コミッション率'],
  deviceType: ['デバイス', 'デバイス種別', '端末', '端末種別'],
  trackingId: ['計測ID', 'トラッキングID', '計測id'],
  status: ['ステータス', '状態', '確定状況', '成果状況'],
};

export const FIELD_LABELS = {
  occurredAt: '発生日時',
  itemNameRaw: '商品名',
  shopName: 'ショップ名',
  genreName: 'ジャンル',
  salesAmount: '売上金額',
  reward: '報酬',
  rate: '料率',
  deviceType: 'デバイス',
  trackingId: '計測ID',
  status: 'ステータス',
};

export const REQUIRED_FIELDS = ['occurredAt', 'itemNameRaw', 'salesAmount', 'reward'];

/** UTF-8 で厳密デコードを試し、失敗したら Shift_JIS(cp932) で読み直す */
export function decodeCsv(buffer) {
  const bytes = new Uint8Array(buffer);
  // BOM 付き UTF-8
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'UTF-8 (BOM)' };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text, encoding: 'UTF-8' };
  } catch {
    return { text: new TextDecoder('shift_jis').decode(bytes), encoding: 'Shift_JIS' };
  }
}

/** RFC4180 準拠のCSVパーサ（引用符内の改行・カンマ・二重引用符に対応） */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function normalizeHeader(text) {
  return String(text ?? '')
    .replace(/^﻿/, '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[\s　]/g, '')
    .trim();
}

/** ヘッダ行から列名でマッピングを推定する。位置の決め打ちはしない */
export function guessMapping(headers) {
  const normalized = headers.map(normalizeHeader);
  const mapping = {};
  const used = new Set();

  // 完全一致を全フィールドで先に確定させてから部分一致に降りる。
  // フィールドごとに「完全一致→部分一致」を回すと、先に処理したフィールドの部分一致が
  // 後のフィールドの完全一致相手を奪う（例: 売上金額が「報酬金額」列を取ってしまう）。
  const assign = (matcher) => {
    for (const [field, candidates] of Object.entries(FIELD_CANDIDATES)) {
      if (mapping[field] !== undefined) continue;
      for (const candidate of candidates) {
        const index = normalized.findIndex((h, idx) => !used.has(idx) && matcher(h, candidate));
        if (index !== -1) {
          mapping[field] = index;
          used.add(index);
          break;
        }
      }
    }
  };

  assign((header, candidate) => header === candidate);
  assign((header, candidate) => header.includes(candidate));
  return mapping;
}

export function parseAmount(value) {
  if (value === null || value === undefined) return 0;
  const text = String(value).replace(/[¥￥,，\s円]/g, '');
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
}

/** "4%" / "4" / "0.04" のいずれでも小数に揃える */
export function parseRate(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const text = String(value).replace(/[%％\s]/g, '');
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1 ? n / 100 : n;
}

/** 日時を JST の ISO 8601 に揃える。時刻が無い場合は 00:00 とする */
export function parseCsvDateTime(value) {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  const m = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/.exec(text);
  if (!m) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${m[1]}-${pad(m[2])}-${pad(m[3])}T${pad(m[4] ?? 0)}:${pad(m[5] ?? 0)}:${pad(m[6] ?? 0)}+09:00`;
}

/**
 * 解析結果を成果レコード（仕様書 5.5）に変換する。
 * 必須列が欠けていてもエラーで落とさず、warnings と未マッピング一覧を返す。
 */
export function buildResults(rows, mapping) {
  const [, ...body] = rows;
  const warnings = [];
  const missing = REQUIRED_FIELDS.filter((f) => mapping[f] === undefined);
  if (missing.length > 0) {
    warnings.push(`必須列が見つかりません: ${missing.map((f) => FIELD_LABELS[f]).join('、')}。手動で列を指定してください`);
    return { results: [], warnings, missing };
  }

  const pick = (row, field) => (mapping[field] === undefined ? '' : (row[mapping[field]] ?? ''));
  const results = [];
  let skipped = 0;

  for (const row of body) {
    const occurredAt = parseCsvDateTime(pick(row, 'occurredAt'));
    // 突合キーなので trim しない。投稿ログ側も無加工で保存している（仕様書 5.4 / 10.3）
    const itemNameRaw = String(pick(row, 'itemNameRaw'));
    if (!occurredAt || itemNameRaw.trim() === '') {
      skipped += 1;
      continue;
    }
    const salesAmount = parseAmount(pick(row, 'salesAmount'));
    const reward = parseAmount(pick(row, 'reward'));
    results.push({
      occurredAt,
      itemNameRaw,
      shopName: String(pick(row, 'shopName')).trim(),
      genreName: String(pick(row, 'genreName')).trim(),
      salesAmount,
      reward,
      rate: parseRate(pick(row, 'rate')) ?? (salesAmount > 0 ? reward / salesAmount : null),
      deviceType: String(pick(row, 'deviceType')).trim(),
      trackingId: String(pick(row, 'trackingId')).trim(),
      status: String(pick(row, 'status')).trim(),
      matchedPostId: null,
    });
  }

  if (skipped > 0) warnings.push(`日付または商品名を読み取れない ${skipped} 行を読み飛ばしました`);
  return { results, warnings, missing: [] };
}

export function importCsv(buffer) {
  const { text, encoding } = decodeCsv(buffer);
  const rows = parseCsv(text);
  if (rows.length === 0) return { encoding, headers: [], rows: [], mapping: {}, results: [], warnings: ['空のファイルです'], missing: [] };
  const headers = rows[0];
  const mapping = guessMapping(headers);
  const built = buildResults(rows, mapping);
  return { encoding, headers, rows, mapping, ...built };
}
