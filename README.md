# bug-workspace

BUG泡瀬店 月間セッション目標管理Webアプリ　／　トレーニング記録アプリ

このリポジトリには2つの独立したWebアプリが入っています。
- ルート（このフォルダ）… 月間・週間セッション目標の管理アプリ
- `training/` … 会員ごとの身体データ・トレーニング記録アプリ（Supabaseでリアルタイム共有、詳細は [training/README.md](training/README.md)）

## これは何か（月間セッション目標管理）
パーソナルトレーナー業務向けの「月間・週間セッション目標」と「会員ごとの実施・予約状況」を管理するシンプルなWebアプリです。iPad・iPhoneのSafariで数秒で確認できることを目指しています。

外部の有料サービスは使わず、HTML / CSS / JavaScript のみで作られています。データは端末のブラウザ内（localStorage）に保存されます。

## 使い方（トレーナー向け）
詳しい使い方は、アプリを開いた際にClaudeとの会話で案内された内容、またはリポジトリのやり取りを参照してください。

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
- `app.js` … 計算・保存・操作ロジック
- `manifest.json` / `icon.svg` … ホーム画面追加用アイコン設定
