/**
 * 商品名からハッシュタグ候補を作る（追加要件v1.2 4章）。
 *
 * **なぜニッチタグが要るか。**
 * 実測では #鶏なんこつ唐揚げ（ニッチ）で1位、#無洗米（中規模）で中位、
 * #お取り寄せスイーツ（ビッグ）で圏外。フォロワーが少ないうちは
 * ビッグタグでは埋もれて露出しないため、ニッチタグが唯一の露出経路になる。
 *
 * ニッチタグは商品名から作るしかないが、楽天の商品名は販促文と
 * 数量表記だらけで、そのまま切ると `#1kg` `#送料` のような無意味な断片が出る。
 * ここでは 1) 販促文を落とす 2) 文字種の切れ目で語を割る 3) 除外語で濾す
 * の3段で候補を作る。
 */

import { cleanName } from './itemName.js';

/** タグにしても検索されない語。数量・販促・配送まわり */
const STOPWORDS = new Set([
  '送料',
  '送料無料',
  '訳あり',
  '最安値',
  'クーポン',
  'ポイント',
  'セール',
  'タイムセール',
  '限定',
  '期間限定',
  '在庫',
  '数量',
  '入り',
  '個入',
  '本入',
  '袋入',
  'セット',
  '詰め合わせ',
  'お試し',
  '新商品',
  '日本製',
  '国内発送',
  'あす楽',
  '即納',
  '選べる',
  '合計',
  '税込',
  '税抜',
  '円',
  '約',
  'サイズ',
  '当店',
  '楽天',
  '市場',
  'ランキング',
  '第',
  '位',
  '冠',
  'レビュー',
  '高評価',
  'キロ',
  'グラム',
  'ミリ',
  'センチ',
  '入荷',
  '発送',
  '令和',
  '平成',
  '年産',
  '年度',
  '産地',
  '対応',
  '専用',
  '各種',
  '新登場',
]);

/** 助数詞から始まる断片。「4個セット」を割った残りの「個セット」などを弾く */
const COUNTER_HEAD = /^(?:個|本|袋|箱|枚|入|食|缶|杯|人前|パック|セット|kg|g|ml)/iu;

/** 数量だけの語。`#1kg` `#500g` `#10個` を弾く */
const QUANTITY_ONLY = /^[\d,.]+\s*(?:kg|ｋｇ|g|ｇ|mg|l|ml|cc|個|本|袋|箱|枚|パック|入|人前|食|缶|杯|セット|kgx\d+)?$/iu;

/** 語の末尾に付く数量。「サバ切身1kg」→「サバ切身」 */
const TRAILING_QUANTITY = /[\d,.]+\s*(?:kg|ｋｇ|g|ｇ|mg|l|ml|cc|個|本|袋|箱|枚|パック|入|人前|食|缶|杯)?$/iu;

/** 日本語を1文字も含まない語は、ブランド名の可能性があるので3文字以上だけ通す */
const HAS_JA = /[぀-ヿ㐀-鿿]/u;

/**
 * 商品名に出てきたら足したいカテゴリタグ。
 * 商品名の語をそのまま切っただけでは出てこない、検索される言い回しを補う。
 */
const KEYWORD_TAGS = [
  [/骨取り|骨なし|骨抜き/u, ['骨取り魚', '魚のおかず']],
  [/無洗米/u, ['無洗米', 'お米']],
  [/(?<!無洗)米|玄米|新米/u, ['お米', 'まとめ買い']],
  [/冷凍/u, ['冷凍ストック', '冷凍食品']],
  [/レトルト|常温保存/u, ['レトルト', 'ストック食材']],
  [/ふりかけ|混ぜ込み|混ぜご飯/u, ['ごはんのお供', 'ふりかけ']],
  [/海苔|のり佃煮|佃煮/u, ['ごはんのお供']],
  [/唐揚げ|からあげ|竜田揚げ/u, ['唐揚げ', 'お弁当おかず']],
  [/弁当|お弁当/u, ['お弁当おかず', '弁当作り']],
  [/業務用|大容量|まとめ買い/u, ['業務用', 'まとめ買い']],
  [/産地直送|直送|産直/u, ['産地直送']],
  [/カット済|切身|切り身|小分け/u, ['時短ごはん', '小分け冷凍']],
  [/パスタ|うどん|そば|中華麺|ラーメン/u, ['麺類ストック']],
  [/保存容器|タッパー|密閉容器/u, ['保存容器', '作り置き']],
  [/水筒|タンブラー/u, ['水筒']],
  [/弁当箱/u, ['弁当箱']],
  [/鍋|フライパン|調理器具/u, ['キッチン用品']],
];

/** 中規模タグ。カテゴリとして検索されるが、競合もそれなりに多い層 */
const MID_TAGS = [
  '冷凍食品',
  '冷凍ストック',
  'まとめ買い',
  '作り置き',
  '時短ごはん',
  'ごはんのお供',
  'お弁当おかず',
  '業務用',
  '産地直送',
  '無洗米',
  'キッチン用品',
];

/** ビッグタグ。競合が多く単独では露出しないので2〜3個まで */
const BIG_TAGS = ['お取り寄せ', '楽天ROOM', '買ってよかった', '我が家のお取り寄せ', 'おうちごはん'];

/** 撮影した写真を使うときだけ付けるタグ（ランク条件かつ上位表示の要因） */
export const ORIGINAL_PHOTO_TAG = 'オリジナル写真';

/**
 * 文字種の切れ目で語を割る。
 * 「骨取りサバ切身」→ ['骨取り', 'サバ', '切身'] のように分ける。
 * 形態素解析は持ち込めないので、漢字／ひらがな／カタカナ／英数の切り替わりを境目とする。
 */
function splitByScript(word) {
  const units = [];
  let current = '';
  let kind = '';
  for (const ch of word) {
    const next = /[぀-ゟ]/u.test(ch)
      ? 'hira'
      : /[゠-ヿー]/u.test(ch)
        ? 'kata'
        : /[㐀-鿿]/u.test(ch)
          ? 'kanji'
          : /[0-9a-zA-Z]/u.test(ch)
            ? 'ascii'
            : 'other';
    // ひらがなは送り仮名なので、直前の漢字にくっつける（「骨取り」を割らない）
    const merge = kind === next || (kind === 'kanji' && next === 'hira');
    if (merge || current === '') {
      current += ch;
      if (current.length === 1 || !merge) kind = next;
    } else {
      units.push(current);
      current = ch;
      kind = next;
    }
  }
  if (current !== '') units.push(current);
  return units.filter((u) => u.trim() !== '' && !/^[^぀-ヿ㐀-鿿0-9a-zA-Z]+$/u.test(u));
}

/** タグとして使える語か */
function usable(word) {
  const w = word.trim();
  if (w.length < 2) return false;
  if (STOPWORDS.has(w)) return false;
  if (QUANTITY_ONLY.test(w)) return false;
  if (!HAS_JA.test(w) && w.length < 3) return false;
  // 数字で始まる語は数量表記の残骸であることが多い
  if (/^[\d,.]/u.test(w)) return false;
  if (COUNTER_HEAD.test(w)) return false;
  return true;
}

/** 商品名からニッチタグ候補を作る */
function nicheFrom(itemName) {
  const cleaned = cleanName(itemName);
  const out = [];
  const push = (word) => {
    const w = word.replace(TRAILING_QUANTITY, '').trim();
    if (usable(w) && !out.includes(w)) out.push(w);
  };

  for (const token of cleaned.split(/[\s　・､、,／/｜|＋+＆&×xX*＊()（）\[\]{}]+/u)) {
    if (token === '') continue;
    const units = splitByScript(token);
    // 隣り合う語をつないだ複合語を優先する。
    // 「骨取り」「サバ」単体より「骨取りサバ」のほうが商品にたどり着く
    for (let i = 0; i < units.length - 1; i += 1) push(units[i] + units[i + 1]);
    for (const unit of units) push(unit);
  }
  // 長い候補の一部でしかない語を落とす。
  // 「骨取りサバ」があるなら「骨取り」「サバ」は要らない（分割しただけの断片になる）
  return out.filter((w) => !out.some((other) => other !== w && other.includes(w)));
}

/**
 * 商品名から3層のタグ候補を返す。
 *
 * `pastHashtags` に過去の投稿で使ったタグを渡すと、よく使っているものを
 * 中規模層の先頭に寄せる（自分のコレクションタグを取りこぼさないため）。
 */
export function suggestTags(itemName, { pastHashtags = [], limit = 6 } = {}) {
  const name = String(itemName ?? '');
  const niche = nicheFrom(name);

  const keyword = [];
  for (const [pattern, tags] of KEYWORD_TAGS) {
    if (!pattern.test(name)) continue;
    for (const tag of tags) if (!keyword.includes(tag)) keyword.push(tag);
  }

  // 過去によく使ったタグ。自分のコレクションタグや定番の言い回しを拾う
  const counts = new Map();
  for (const tag of pastHashtags) {
    const bare = String(tag).replace(/^#/u, '').trim();
    if (bare === '') continue;
    counts.set(bare, (counts.get(bare) ?? 0) + 1);
  }
  const frequent = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);

  const isBig = (tag) => BIG_TAGS.some((b) => b.toLowerCase() === tag.toLowerCase());
  const mid = [];
  const addMid = (tag) => {
    if (!isBig(tag) && !mid.includes(tag)) mid.push(tag);
  };
  // 商品名から出た語でも、カテゴリとして広く使われるものは中規模層に置く。
  // 「#まとめ買い」をニッチとして出すと、露出の当てが外れる
  for (const tag of keyword) addMid(tag);
  for (const tag of niche) if (MID_TAGS.includes(tag)) addMid(tag);
  // よく使っているタグ（自分のコレクションタグなど）は取りこぼさない
  for (const tag of frequent) if (counts.get(tag) >= 3) addMid(tag);

  // **関係ない中規模タグで埋めない。** 商品と無関係なタグが並ぶと、
  // どれが効くのか分からなくなり、選ぶ手が止まる
  return {
    niche: niche.filter((tag) => !mid.includes(tag) && !isBig(tag)).slice(0, limit),
    mid: mid.slice(0, limit),
    big: BIG_TAGS.slice(0, 4),
  };
}

/** 候補をコピー用の1行にする */
export function tagLine(tags) {
  return tags.map((t) => `#${t}`).join(' ');
}
