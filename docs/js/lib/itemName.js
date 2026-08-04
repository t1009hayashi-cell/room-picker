/**
 * 商品名を楽天ROOM内の検索に貼れる形に整える。
 *
 * 楽天の商品名は中央値でも100文字を超え、先頭に販促の囲み文（【】や＼／）、
 * 後半に検索用キーワードが並ぶ。そのままコピーすると
 * 「長すぎる」と検索が通らない。
 *
 * **先頭からN文字で切るだけにはしない。**
 * 先頭は販促文であることが多く（例:「【ふるさと納税】高評価★4.82【部位が選べる！】国産若鶏…」）、
 * 単純に切ると販促文だけをコピーして商品にたどり着けない。
 * 販促文を落としてから、語の途中で切れないように語単位で積む。
 */

/** コピーする長さの上限。ROOMの検索欄で弾かれない範囲に収める */
export const SEARCH_QUERY_MAX = 30;

/** 先頭に付く販促の囲み文。【】［］[]＜＞《》、＼…／ を対象にする */
const LEADING_BLOCK = /^\s*(?:【[^】]*】|［[^］]*］|\[[^\]]*\]|＜[^＞]*＞|《[^》]*》|＼[^／]*／)\s*/u;

/**
 * 商品名のどこにあっても落とす販促の語。
 * 商品の特性を表す語（訳あり・無塩・冷凍・大容量など）は**落とさない**。
 * 検索の手がかりになるため。
 */
const PROMO_PATTERNS = [
  /【[^】]*】/gu, // 途中に挟まる囲み文
  /［[^］]*］/gu,
  /＼[^／]*／/gu,
  // 「有塩or無塩」のような選択肢の注記。検索には効かない。
  // 『』は商品名そのものが入ることがあるので残す（例:『マダムブリュレ』）
  /「[^」]*」/gu,
  /ポイント\s*\d+(?:\.\d+)?\s*倍/gu,
  /\d+(?:\.\d+)?\s*[%％]\s*OFF/giu,
  /\d+(?:,\d{3})*\s*円\s*→\s*\d+(?:,\d{3})*\s*円/gu,
  // 「お試し送料無料2,990円～」「更に2個で600円OFF！」のような価格の売り文句。
  // 落とさないと、この部分だけがコピーされて商品にたどり着けない
  /お試し\s*送料無料\s*[\d,]+\s*円\s*[〜～]?/gu,
  /更に\s*\d+\s*個で\s*[\d,]+\s*円\s*OFF[！!]?/giu,
  /\d+\s*個(?:購入)?で\s*[\d,]+\s*円\s*OFF[！!]?/giu,
  /[\d,]+\s*円\s*[〜～]/gu,
  /(?:SALE|セール|タイムセール|限定価格|期間限定価格)/giu,
  /送料無料/gu,
  /あす楽|あすらく|翌日配送/gu,
  /高評価\s*★?\s*\d+(?:\.\d+)?/gu,
  /★\s*\d+(?:\.\d+)?/gu,
  /(?:楽天)?グルメ大賞[^\s]*/gu,
  /レビュー特典[！!]?/gu,
  /\d+冠(?:達成)?/gu,
  /\S*が選べる[！!]?/gu,
  /\d{1,2}\s*\/\s*\d{1,2}\s*\([月火水木金土日]\)\s*\d{1,2}\s*[:：]\s*\d{2}\s*まで/gu,
  /\d{1,2}月\s*\d{1,2}日\s*\d{0,2}[:：]?\d{0,2}\s*まで/gu,
];

/** 検索の邪魔になる記号。区切りとして空白に置き換える */
const NOISE = /[★☆♪♥❤◆■●▲▼※▽△◎〇｜|＿…‥･･⇒→⇔≪≫]/gu;

/**
 * これだけになったら検索に使えない語。
 * 販促文を落とした結果これしか残らないことがあるため、その場合は切り出し方を変える。
 */
const TOO_VAGUE = ['お試し', 'ギフト', 'セット', '訳あり', '新商品', '限定'];

/**
 * 商品名を検索用の短い文字列にする。
 * 整形の結果が空になった場合は、元の商品名を上限で切ったものを返す（必ず何かを返す）。
 */
export function toSearchQuery(itemName, maxLength = SEARCH_QUERY_MAX) {
  const original = String(itemName ?? '').trim();
  if (original === '') return '';

  // 先頭の囲み文は連続することがあるので、消えなくなるまで繰り返す
  let text = original;
  for (;;) {
    const next = text.replace(LEADING_BLOCK, '');
    if (next === text) break;
    text = next;
  }

  for (const pattern of PROMO_PATTERNS) text = text.replace(pattern, ' ');
  text = text.replace(NOISE, ' ');
  // 全角空白もまとめて1つの区切りにする
  text = text.replace(/[\s　]+/gu, ' ').trim();
  // 販促文を落とした跡に残る先頭の句読点・記号を落とす（例:「！ 5個購入で…」）
  text = text.replace(/^[！!？?、。,.・\-‐–—/／]+\s*/u, '').trim();

  const source = text === '' ? original : text;
  const picked = takeWords(source, maxLength);

  // 販促文を落としたら曖昧な語しか残らなかった場合。
  // そのままでは検索に使えないので、整形後の全体を上限で切って商品名の中身を拾う
  if (picked === '' || TOO_VAGUE.includes(picked.trim())) {
    return cut(source.replace(/^(?:お試し|ギフト|セット)\s*/u, '').trim(), maxLength).trim();
  }
  // 末尾に残った区切り記号を落とす（例:「国産若鶏バラエティセット-」）
  return picked.replace(/[-‐‑–—・､、,\/／]+$/u, '').trim();
}

/** 語の途中で切らずに、上限を超えない範囲で先頭から積む */
function takeWords(text, maxLength) {
  const words = text.split(' ').filter((w) => w !== '');
  if (words.length === 0) return cut(text, maxLength);

  const picked = [];
  let length = 0;
  for (const word of words) {
    const added = picked.length === 0 ? charLength(word) : charLength(word) + 1;
    if (length + added > maxLength) break;
    picked.push(word);
    length += added;
  }

  // 1語目だけで上限を超える場合は、その語を上限で切る（空を返さない）
  if (picked.length === 0) return cut(words[0], maxLength);
  return picked.join(' ');
}

function charLength(text) {
  return Array.from(text).length;
}

function cut(text, maxLength) {
  return Array.from(text).slice(0, maxLength).join('');
}
