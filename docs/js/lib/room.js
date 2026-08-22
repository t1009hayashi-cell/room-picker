/**
 * 楽天ROOMへの遷移。
 *
 * **投稿画面は `/mix?itemcode=` で直接開ける。**
 * 楽天市場の商品ページにある「ROOMに投稿」ボタンの遷移先がこれ。
 * `itemcode` は `ショップコード:商品ID` をURLエンコードしたもので、
 * アプリが持っている `itemCode` がそのまま使える。
 *
 * 2026-08-22 に実際に確認した結果は次のとおり。
 *
 * | URL | 結果 |
 * |---|---|
 * | `/mix?itemcode=shop%3Aid` | 200。未ログインだと楽天ログインへ転送され、戻ると投稿画面 |
 * | `/search/item?keyword=` | 200「ROOM : 検索結果」 |
 * | `/items/new` | `/all/items`（新着一覧）へ転送。投稿フォームではない |
 * | `/post` `/add` `/collect` `/item/new` | すべて404 |
 *
 * 商品ページのボタンには `scid=we_room_upc60`（楽天側の計測パラメータ）が付くが、
 * **こちらからは付けない。** 楽天が自社導線を測るための値で、
 * 別の場所からの遷移に流用すると計測を汚す。
 */

import { toSearchQuery } from './itemName.js';

/**
 * その商品の投稿画面。`itemCode` は `ショップコード:商品ID`。
 * 未ログインなら楽天のログインを挟んでから投稿画面に戻る。
 */
export function roomPostUrl(itemCode) {
  const code = String(itemCode ?? '').trim();
  if (code === '') return null;
  return `https://room.rakuten.co.jp/mix?itemcode=${encodeURIComponent(code)}`;
}

/**
 * ROOMの商品検索。
 * `itemCode` が無い（手入力で商品IDを取れなかった）ときの逃げ道。
 * 商品名は長すぎると弾かれるので、検索用に短くしたものを渡す。
 */
export function roomSearchUrl(itemName) {
  const query = toSearchQuery(itemName ?? '');
  return `https://room.rakuten.co.jp/search/item?keyword=${encodeURIComponent(query)}`;
}

/** 投稿画面を優先し、取れなければ検索に落とす */
export function roomUrlFor(item) {
  return roomPostUrl(item?.itemCode) ?? roomSearchUrl(item?.itemName);
}

/** ROOMのトップ。どうにもならないときの逃げ道 */
export const ROOM_TOP_URL = 'https://room.rakuten.co.jp/';
