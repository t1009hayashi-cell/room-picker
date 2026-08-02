# 引き継ぎメモ（2026-08-02 時点）

新しいチャットで作業を再開するときは、まずこのファイルと `README.md` を読むこと。
仕様の正は `room_assist_requirements.md`。

---

## 1. 現在の状態

**Phase 1〜5 の実装は完了済み。実データで本番稼働している。**

| 項目 | 状態 |
|---|---|
| リポジトリ | https://github.com/t1009hayashi-cell/room-picker （Public） |
| 公開URL | https://t1009hayashi-cell.github.io/room-picker/ |
| 自動実行 | 毎朝 06:00 JST（`.github/workflows/daily.yml`） |
| テスト | 123件すべて合格（`npm test`） |
| 初回の実データ取得 | 2026-08-02 に成功。398件取得 / 166件が条件通過 / セール2件を自動検出 |

GitHub Secrets には次の3つが登録済み。

- `RAKUTEN_APPLICATION_ID` … 楽天アプリ管理画面の「アプリケーションID」
- `RAKUTEN_ACCESS_KEY` … 同じく「アクセスキー」
- `RAKUTEN_AFFILIATE_ID` … 任意

---

## 2. 絶対に忘れてはいけない知見（楽天API 2026年刷新）

**仕様書に書かれている旧APIは廃止済み。** ここで長時間ハマったので必ず読むこと。

| | 旧（仕様書の記述・使用不可） | 新（実装で採用） |
|---|---|---|
| ランキング | `app.rakuten.co.jp/services/api/IchibaItem/Ranking/20220601` | `openapi.rakuten.co.jp/`**`ichibaranking`**`/api/IchibaItem/Ranking/20220601` |
| 検索 | `app.rakuten.co.jp/services/api/IchibaItem/Search/20220601` | `openapi.rakuten.co.jp/`**`ichibams`**`/api/IchibaItem/Search/20220601` |
| 認証 | `applicationId` のみ | `applicationId` **と** `accessKey` の両方が必須 |

### 切り分けの落とし穴

- **ランキングと検索でサービスパスが違う**（`ichibaranking` / `ichibams`）。共通だと思うと 404。
- 旧エンドポイントに正しい値を送っても `specify valid applicationId` が返る。
  **でたらめな値を送ったときと完全に同じ応答**なので「IDが間違っている」と誤解しやすい。
  空値で送ると `client_id or access_token is required` になるので、その差で切り分けられる。
- **楽天のテストフォームは楽天サーバー内部から実行される。**
  テストフォームで通っても外部から使える証明にはならない。
  疎通確認はブラウザのアドレス欄にエンドポイントURLを直接入力して行うこと。
- 「許可されたWebサイト / IPアドレス」「アプリケーションタイプ」は今回の原因ではなかった。
  現在は API/バックエンドサービスタイプ + 許可IP `0.0.0.0/0` で登録されているが、
  旧アプリ（Webアプリケーションタイプ）の値でも新エンドポイントなら通る。

この件の反省は `../growth folder/2026-08-02_rakuten-api-legacy-endpoint-misdiagnosis.md` に記録済み。

---

## 3. 未修正のバグ（次にやること）

実機（iPhone）で確認された3件。いずれも PWA 側（`docs/`）の問題。

### バグ1: 長押しするとiOSのメニューが出る

**症状**
カレンダーの日付を長押しすると、iOS Safari の「新規タブで開く」等のコンテキストメニューが出てしまう。

**原因（推定）**
`docs/js/views/calendar.js` に 480ms の長押しで想定報酬合計をポップアップする実装がある
（仕様書8.1「セルを長押しすると、その日の想定報酬合計をポップアップ表示」）。
これが iOS 標準の長押し動作と競合している。
`docs/css/style.css` の `.cal__cell` には `user-select: none` はあるが
**`-webkit-touch-callout: none` が無い**。

**対応方針**
- `.cal__cell` と `a` 要素に `-webkit-touch-callout: none;` を追加
- 併せて `touch-action` の指定も見直す（現在 `.cal__grid` に `pan-y`）
- 実機確認が必須。ブラウザのエミュレーションでは再現しない可能性が高い

### バグ2: 楽天リンクが商品ページまで飛ばない

**症状**
「楽天で開く」を押すと楽天アプリは起動するが、商品ページではなくトップページに着地する。

**原因（推定）**
`sanitizeUrl()`（`src/util/url.ts`）で `rafcid` を除去した後の `itemUrl` を
`docs/js/views/dayList.js` の `<a target="_blank" rel="noopener noreferrer">` で開いている。
楽天アプリの Universal Links が URL を横取りし、パスを解決できずトップに落としていると思われる。

**調査の起点**
1. `docs/data/2026-08-02.json` の `itemUrl` の実値を確認し、パスが欠けていないか見る
   （`https://item.rakuten.co.jp/<shopCode>/<itemPath>/` の形になっているはず）
2. 同じURLを iPhone のブラウザに直接貼って開くとどうなるか確認
   → トップに飛ぶならアプリ側の挙動、商品ページに行くならこちらのリンク実装の問題
3. 対策候補
   - `affiliateId` を設定して `affiliateUrl` を使う（仕様書4.1では `affiliateId` 指定時に返る）
   - Universal Links を回避する開き方を試す
   - 商品ページのURL形式を見直す

**注意**: `rafcid` の除去自体は仕様書4.1.2の必須要件なので、除去をやめる方向で解決しないこと。

### バグ3: ページごとにレイアウトが崩れる

**症状**
スマホで見たとき、画面によってレイアウトが違う。
カレンダー・分析・設定のタブバーが表示されなかったり、上に表示されたりする。

**原因（推定）**
`docs/css/style.css` の `.tabbar` は `position: fixed; inset: auto 0 0 0;`。
iOS Safari はアドレスバーの伸縮でビューポート高さが動的に変わるため、
`fixed` 要素の位置が不安定になる。
また `.view` の `padding-bottom` が
`calc(var(--tabbar-h) + env(safe-area-inset-bottom) + 24px)` に依存しており、
コンテンツが短い画面（候補0件の日など）で見え方が変わる。

**対応方針**
- `100vh` ではなく `100dvh`（動的ビューポート単位）を使う
- `body` に `min-height: 100dvh` を持たせ、コンテンツが短くても高さが確定するようにする
- タブバーを `position: sticky` にする案も検討
- **各画面（カレンダー / 日別リスト / 分析 / 設定）と、候補0件の日でも確認すること**

---

## 4. 補足

- **現在公開中のデータは、投稿文の修正（コミット `bae766f`）より前に生成されたもの。**
  珪藻土バスマットの投稿文が「水の買い出しに使う時間…」になっているのはそのため。
  翌朝の自動実行で正しい内容に置き換わる。
- 順位変動（↑↓）は前日データが必要なため、2日目以降から表示される。
- 実機の画面では投稿文が「本文 79文字」で推奨範囲（80〜150）を下回り警告が出ていた。
  カテゴリ語の変更で文字数が変わるため、修正後のデータで再確認すること。
- ユーザーはプログラミングの専門知識を前提としない説明を求めている。
  専門用語を避け、操作は具体的な手順で案内すること。
- 認証情報（アプリID・アクセスキー）は絶対にコードやリポジトリに書かない。
  ユーザーにも値をチャットに貼らないよう案内すること。
