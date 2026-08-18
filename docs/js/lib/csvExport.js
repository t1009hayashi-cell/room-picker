/**
 * 投稿ログ・成果データをCSVで書き出す。
 *
 * アプリ内の分析だけでは足りないとき、表計算ソフトで自由に集計できるようにする。
 * **Excelで開く前提なので UTF-8 BOM を付ける。** 付けないと日本語が文字化けする。
 */

/** CSVの1セルを安全に囲む。カンマ・改行・引用符を含む値を壊さない */
function cell(value) {
  if (value === null || value === undefined) return '';
  const text = Array.isArray(value) ? value.join(' ') : String(value);
  // Excelが数式として解釈するのを防ぐ（= + - @ で始まる値）
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** 列定義（見出しと取り出し方）から CSV 文字列を作る */
export function toCsv(rows, columns) {
  const header = columns.map((c) => cell(c.label)).join(',');
  const body = rows.map((row) => columns.map((c) => cell(c.value(row))).join(',')).join('\r\n');
  // BOM を付けて Excel が UTF-8 と判定できるようにする
  return `\uFEFF${header}\r\n${body}\r\n`;
}

const yesNo = (v) => (v ? 'あり' : 'なし');

/**
 * 投稿ログの列。
 * 分析用に記録している特徴（`features`）も1列ずつ出す。
 * 表計算ソフト側でピボットして層別できるようにするため。
 */
export const POST_COLUMNS = [
  { label: '投稿日時', value: (p) => p.postedAt ?? '' },
  { label: '見ていた日', value: (p) => p.dateKey ?? '' },
  { label: '商品コード', value: (p) => p.itemCode ?? '' },
  { label: '商品名', value: (p) => p.itemNameRaw ?? '' },
  { label: 'ショップ', value: (p) => p.shopName ?? '' },
  { label: 'ジャンル', value: (p) => p.genreName ?? '' },
  { label: '価格', value: (p) => p.itemPrice ?? '' },
  { label: '想定報酬', value: (p) => p.estimatedReward ?? '' },
  { label: 'レビュー件数', value: (p) => p.reviewCount ?? '' },
  { label: 'レビュー増加', value: (p) => p.reviewCountChange ?? '' },
  { label: '順位', value: (p) => p.rankAtPost ?? '' },
  { label: '順位変動', value: (p) => p.rankChangeAtPost ?? '' },
  // 投稿前に手で選んだ分類
  { label: 'ヘッダー型', value: (p) => p.headerType ?? '' },
  { label: '角度', value: (p) => p.angle ?? '' },
  { label: '選定基準', value: (p) => (p.criteria ?? []).join('／') },
  { label: 'セール期間中', value: (p) => yesNo(p.duringSale) },
  // 実際に投稿した文章から測った特徴
  { label: 'ヘッダー文字数', value: (p) => p.features?.headerLength ?? p.firstLineLength ?? '' },
  { label: '本文文字数', value: (p) => p.features?.bodyLength ?? '' },
  { label: 'タグ込み文字数', value: (p) => p.features?.totalLength ?? '' },
  { label: '行数', value: (p) => p.features?.lineCount ?? '' },
  { label: '1行平均', value: (p) => p.features?.averageLineLength ?? '' },
  { label: '最長行', value: (p) => p.features?.maxLineLength ?? '' },
  { label: 'タグ数', value: (p) => p.features?.hashtagCount ?? (p.hashtags ?? []).length },
  { label: '箇条書き行数', value: (p) => p.features?.bulletLines ?? '' },
  { label: 'CTA', value: (p) => (p.features ? yesNo(p.features.hasCta) : '') },
  { label: '罫線', value: (p) => (p.features ? yesNo(p.features.hasDivider) : '') },
  { label: '絵文字', value: (p) => (p.features ? yesNo(p.features.hasEmoji) : '') },
  { label: 'オリジナル写真タグ', value: (p) => (p.features ? yesNo(p.features.hasOriginalPhotoTag) : '') },
  { label: 'ヘッダー本文', value: (p) => p.firstLine ?? '' },
  { label: 'ハッシュタグ', value: (p) => (p.hashtags ?? []).join(' ') },
  { label: '投稿本文', value: (p) => p.commentBody ?? '' },
];

/** 取り込んだ成果データの列 */
export const RESULT_COLUMNS = [
  { label: '発生日時', value: (r) => r.occurredAt ?? '' },
  { label: '商品名', value: (r) => r.itemNameRaw ?? '' },
  { label: 'ショップ名', value: (r) => r.shopName ?? '' },
  { label: 'ジャンル', value: (r) => r.genreName ?? '' },
  { label: '売上金額', value: (r) => r.salesAmount ?? '' },
  { label: '報酬', value: (r) => r.reward ?? '' },
  { label: '料率', value: (r) => r.rate ?? '' },
  { label: 'デバイス', value: (r) => r.deviceType ?? '' },
  { label: '計測ID', value: (r) => r.trackingId ?? '' },
  { label: 'ステータス', value: (r) => r.status ?? '' },
  { label: '紐付けた投稿', value: (r) => r.matchedPostId ?? '' },
];
