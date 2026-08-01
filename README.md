# 楽天ROOM 投稿支援ツール

楽天市場のランキング／検索APIから投稿候補を毎朝抽出し、iPhoneのPWAから
候補の確認・投稿文の管理・投稿予定日の割当・成果の分析までを行う。

仕様は [`room_assist_requirements.md`](./room_assist_requirements.md) が正。
このREADMEは実装側の手順と、実装時に確定した事項だけを書く。

## 構成

```
GitHub Actions（毎朝 06:00 JST / cron: 0 21 * * * UTC）
  └─ node dist/src/index.js
       ├─ 楽天ランキングAPI + 検索API（直列・1秒以上のsleep）
       ├─ 正規化 → 前日比 → 想定報酬 → hotScore → 除外判定 → 投稿文生成
       ├─ docs/data/YYYY-MM-DD.json を書き出し
       ├─ docs/data/sales.json（ポイント期間からセールを自動検出）
       └─ docs/data/index.json（利用可能な日付一覧）
GitHub Pages（main ブランチの /docs を公開）
  └─ docs/ 配下のPWA（同一オリジンの静的JSONを読むだけ＝CORSが発生しない）
```

| ディレクトリ | 役割 |
|---|---|
| `src/` | 抽出バッチ（TypeScript / Node.js 標準APIのみ） |
| `config/` | ジャンル・NGワード・スコア係数。コードに数値を散らさない |
| `docs/` | PWA本体と生成データ。**GitHub Pages の公開ルート** |
| `test/` | `src/` の単体テスト（`node:test`） |
| `web-test/` | `docs/js/lib/` の純粋ロジックの単体テスト |
| `scripts/` | ローカル確認用サーバとアイコン生成 |

## セットアップ

```bash
npm install
```

```bash
npm test
```

`npm test` はビルド後にバックエンド58件・フロント56件のテストを実行する。

## ローカルでの動かし方

実APIを叩かずにモックデータで一通り確認できる。

```bash
npm run fetch:mock
```

```bash
node dist/src/index.js --mock --date=2026-07-30
```

`--date` を変えて数日分作ると、前日比・hotScore・カレンダーの動きを確認できる。

```bash
npm run serve
```

`http://localhost:4173/` でPWAが開く。

実APIを叩く場合は `.env.example` をコピーして `.env` を作り、アプリIDを入れてから：

```bash
node --env-file=.env dist/src/index.js
```

## GitHub側の設定

1. **リポジトリを Public にする**（無料プランでは Public のみ Pages が使える）。
   `docs/data/*.json` に抽出結果が公開される点を許容すること。
2. Settings → Pages → Source: `Deploy from a branch` / Branch: `main` / Folder: `/docs`
3. Settings → Secrets and variables → Actions に登録
   - `RAKUTEN_APPLICATION_ID`（必須）
   - `RAKUTEN_AFFILIATE_ID`（任意。指定すると `affiliateUrl` が返る）
4. Actions タブから `daily-fetch` を手動実行して疎通を確認する。

アプリIDは `itemUrl` / `shopUrl` の `rafcid` として自動付与されるが、
保存前に除去しているためリポジトリには残らない（`src/util/url.ts`、テストで検証済み）。

## 実装時に確定した事項

仕様書12章の「未解決・要確認」に対する現時点の回答。

| 項目 | 状況 |
|---|---|
| `formatVersion=2` | 既定を `2` にしたうえで、`extractItems()` が v1 の `{Item:{...}}` ネストも吸収する。どちらで返っても動く |
| 検索APIのフィールド | 未検証（実APIを叩いていない）。取得できなかった項目は正規化時に既定値へ落ちる |
| リポジトリの公開可否 | **Public** を前提に構成した |
| Actions の cron 遅延 | 許容。日付は実行時刻の JST から決まる |
| iOSの localStorage 保持 | 未検証。初回案内・エクスポート／インポート・月1リマインドを実装済み |
| 日次JSONのサイズ | **7ジャンル×約40件で 808KB（gzip 33KB / brotli 17KB）**。Pages は gzip 配信 |
| 注文明細CSVの列名・文字コード | 未確認。列名候補を複数持ち、一致しなければ**手動マッピングUI**に落とす。UTF-8 / BOM付き / Shift_JIS を自動判定 |

### 仕様の解釈を確定させた箇所

- **価格の足切り**（6.1）: 価格帯商品（`hasPriceRange:1`）は `itemPriceMax`、それ以外は
  「表示価格は `itemPrice` を正とする」に従い `itemPrice` で判定する。
- **`priceEndTime` による除外**（6.1 と 7章の整合）: 除外判定には**最短の投稿予定日＝抽出日の翌日**を使う。
  それより後ろの日付に割り当たった場合の期限切れは、7章に従いPWA側で翌日に戻して警告を出す。
- **検索APIに `minPrice` を送らない**: 検索APIの `minPrice` は `itemPrice` に効くため、
  仕様書6.1が「取り逃すな」と名指しした価格帯商品（`itemPrice 2788` / `itemPriceMax 8888`）が
  API側で落ちてしまう。価格の足切りは `itemPriceMax` を見るローカル側に任せる。
- **投稿文の「全体80〜150文字」**: 改行文字とハッシュタグ行を除いた本文の文字数として実装した。
  ハッシュタグは `draftComments[].hashtags` に分けて持ち、PWAが本文の下に連結して表示する
  （投稿ログが `commentBody` と `hashtags` を分けて保存する仕様に合わせたため）。
- **AI用プロンプトの商品説明**: 5.1 の「`itemCaption` を300文字で切り詰める」を優先し、
  プロンプトにも切り詰め後の `itemCaptionShort` を渡す。原文は保存しない。
- **`hotScore` の新規ランクイン +30**: 前日JSONが存在する上で載っていなかった商品にのみ加算する。
  前日JSONが無い初回実行では 6.4 に従い加算しない。
- **日時はすべて JST 固定**: Actions（UTC）と端末（任意のTZ）で結果が変わらないよう、
  `getDay()` / `getHours()` などローカルタイム系のAPIは使わない。投稿ログの `postedAt` も `+09:00` 表記。
- **同日同一ショップの警告**（8.2）は、分析が壊れるのが「実際に投稿した日」の重複であることから、
  **当日の投稿ログ**と照合してカード上に赤で警告する（閲覧中の日付ではない）。
  候補の偏り自体は日別リストの先頭に1行だけ出す。カードごとに出すと候補の大半に注意が付き、
  本来の警告が埋もれるため。
- **セール開始日への割当**（7章）: 翌日がすでにセール期間中なら、後ろのセールを待たず翌日に割り当てる。
  セール中でないときだけ、翌日以降で最も近いセール開始日まで待つ。
- **セール日程の編集**（8.4）: 手動登録したセールは名称・期間・削除がすべて可能。
  お買い物マラソンのような「20:00開始・翌01:59終了」を表現できるよう、**時刻まで**指定する。
  自動検出分は期間を編集できない（次回の抽出で再生成されるため）。ずれている場合は
  手動でセールを追加する（同一期間なら手動が優先される）。
- **ジャンルの削除**（8.4）: PWAはGitHub Pages上の静的クライアントでリポジトリに書き戻せないため、
  UIでの「削除」は `enabled: false` として扱う。設定画面の「config/genres.json 用のJSONをコピー」で
  書き出して貼り付けると、翌朝から取得対象外になる（`src/config.ts` が `enabled !== false` で絞る）。

## 既知の制約

- `docs/data/` は空の状態でリポジトリに入っている。開発中に生成したモックデータは
  実データに紛れないよう削除済み。初回の `daily-fetch` が成功すると自動生成される。
  ローカルでモックを試すときは `npm run fetch:mock` で作り、コミットしないこと。
- ジャンル指定漏れの検出（4.1.1）はランキングAPIのレスポンスにのみ適用している。
  検索APIは `title` の書式が未確認のため検査対象外。
- カレンダーは既定で直近31日分の日次JSONを読む（設定画面で変更可）。
  日数を増やすと通信量が増える。
- 日別リストは hotScore 降順のまま **30件ずつ**描画し、「さらに表示」で追加する。
  セール開始日には候補が数百件集中するため（実測413件 = DOM 12,536ノード / HTML 970KB）、
  全件を一度に描くと iPhone で明確に重くなる。分割後は 918ノード / 71KB。
- Service Worker はアプリシェルを stale-while-revalidate で扱う。
  cache-first にすると、コードを直しても `sw.js` の `VERSION` を上げるまで端末に更新が届かない。
- クリック数・表示回数は取得できない（仕様書10.1）。成約率は「投稿した商品のうち何件が売れたか」で代替する。

## テスト

```bash
npm run test:node
```

```bash
npm run test:web
```

投稿文の生成ルール（1行目30〜35文字・本文80〜150文字・3行以内・ハッシュタグ3〜4個・
商品名から書き始めない・禁止語を転記しない）は、8商品×12ヶ月×2角度の全192パターンで検証している。
