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

## 食事サポート管理機能について

会員詳細の「食事サポート」タブから、体重・食事方針などのプロフィール、指導の経緯、LINEトーク履歴、食事報告とそのフィードバック（AI生成FB／トレーナー修正版／実際に送ったFB）を管理できます。有料AI APIは使用しておらず、Claude用のプロンプトを自動生成して「コピー」し、Claude.aiやこのアプリへ手動で貼り付けて使う運用です。

- 必要なテーブルは `supabase/migration.sql` に追加してあります（実行方法は上記と同じ）
- LINE Messaging APIとの自動連携（Webhook）は `supabase/functions/line-webhook/` にコードだけ用意してあります。**Supabase CLIでのデプロイとLINE Developersでの設定が別途必要**です（このリポジトリ内の作業だけでは有効になりません）
- 連携前でも、会員詳細の「食事サポート」タブから手動でトーク履歴・食事報告を追加してテストできます
- `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` は、Supabase Edge Functionsの環境変数（Secrets）にのみ設定します。GitHubやアプリのJavaScript/HTMLには一切書き込みません

## 公開方法（GitHub Pages）
1. GitHubでこのリポジトリを開く
2. 上部メニューの「Settings」→ 左側の「Pages」を開く
3. 「Build and deployment」の「Source」で `Deploy from a branch` を選択
4. ブランチを `main`、フォルダを `/(root)` にして「Save」
5. 数分後、表示されるURL（`https://<ユーザー名>.github.io/bug-workspace/`）にiPad・iPhoneのSafariでアクセス
6. Safariの共有ボタン →「ホーム画面に追加」で、アプリのように使えます

## ファイル構成
- `index.html` … 画面構成
- `style.css` … デザイン
- `app.js` … 計算・保存・操作ロジック（会員データはSupabase、目標値はブラウザ内に保存）
- `supabase-config.js` … Supabase接続設定（URL・anonキー）
- `supabase/migration.sql` … Supabase側に実行するテーブル拡張・作成SQL
- `manifest.json` / `icon.svg` … ホーム画面追加用アイコン設定
