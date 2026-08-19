# bug-workspace

BUG泡瀬店 月間セッション目標管理Webアプリ

## これは何か
パーソナルトレーナー業務向けの「月間・週間セッション目標」と「会員ごとの実施・予約状況」を管理するシンプルなWebアプリです。iPad・iPhoneのSafariで数秒で確認できることを目指しています。

会員データはSupabase（無料枠あり）に保存され、複数の端末で共有されます。月間・週間の目標数値だけはこの端末のブラウザ内に保存されます。

## 使い方（トレーナー向け）
詳しい使い方は、アプリを開いた際にClaudeとの会話で案内された内容、またはリポジトリのやり取りを参照してください。

## Supabaseの接続設定（初回のみ）

会員データを読み書きするには、Supabaseプロジェクトの準備と、このアプリへの接続設定が必要です。

### 1. Supabaseプロジェクトを用意する
すでに `members` テーブルを作成済みのプロジェクトがあれば、それを使います。

### 2. テーブルを拡張する（SQLを1回実行）
1. Supabaseダッシュボードで対象プロジェクトを開く
2. 左メニュー「SQL Editor」→「New query」
3. リポジトリ内の [`supabase/migration.sql`](./supabase/migration.sql) の中身をすべてコピーして貼り付け、「Run」を押す
   - `members` テーブルに `memo`（メモ）・`remaining_contract`（契約残り）・`booked_sessions`（予約済み）などの列が追加されます
   - `session_logs` テーブル（実施日・予約日を記録するテーブル）が新規作成されます
   - 匿名キーからの読み書きを許可する設定（Row Level Security）が有効になります

### 3. URLとキーを取得する
1. Supabaseダッシュボード → 対象プロジェクト → 左メニュー「Project Settings」→「Data API」
2. 「Project URL」をコピー
3. 「Project API keys」の「anon public」キーをコピー
   - ※ `service_role` キー（管理者用の強い権限を持つキー）は絶対に使わないでください

### 4. アプリに設定する
リポジトリ内の `supabase-config.js` を開き、以下を書き換えて保存・コミットします。

```js
window.SUPABASE_CONFIG = {
  url: 'https://xxxxxxxxxxxx.supabase.co',   // ← 手順3で取得したProject URL
  anonKey: 'ここにanon publicキーを貼り付け',
};
```

設定が済むと、アプリを開いたときに自動でSupabaseからデータを読み込みます。未設定のままだと、画面上部に設定を促すメッセージが表示されます。

### セキュリティについて
このアプリにはログイン機能がないため、`anonKey` を知っていれば誰でもデータを読み書きできる状態になります。URLと匿名キーが記載された `supabase-config.js` は、リポジトリを公開設定にしている場合は特に注意してください。より厳密に守りたい場合は、将来的にSupabase Authによるログイン機能の追加をおすすめします。

## 公開方法（GitHub Pages）
1. GitHubでこのリポジトリを開く
2. 上部メニューの「Settings」→ 左側の「Pages」を開く
3. 「Build and deployment」の「Source」で `Deploy from a branch` を選択
4. ブランチを `main`、フォルダを `/(root)` にして「Save」
5. 数分後、表示されるURL（`https://<ユーザー名>.github.io/bug-workspace/`）にiPad・iPhoneのSafariでアクセス
6. Safariの共有ボタン →「ホーム画面に追加」で、アプリのように使えます

## Gyms連携（予約の自動反映）について
Gyms（予約管理アプリ）からの予約通知メールを自動で読み取り、このアプリの予約データへ反映する機能です。設定方法は [`gyms-sync/README.md`](./gyms-sync/README.md) を参照してください。

## ファイル構成
- `index.html` … 画面構成
- `style.css` … デザイン
- `app.js` … 計算・保存・操作ロジック（会員データはSupabase、目標値はブラウザ内に保存）
- `supabase-config.js` … Supabase接続設定（URL・anonキー）
- `supabase/migration.sql` … Supabase側に実行するテーブル拡張・作成SQL
- `gyms-sync/` … Gyms連携（予約の自動反映）用のGoogle Apps Scriptと設定手順
- `manifest.json` / `icon.svg` … ホーム画面追加用アイコン設定
