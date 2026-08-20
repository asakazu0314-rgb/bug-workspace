# トレーニング記録アプリ（training フォルダ）

会員ごとの身体データ・トレーニング記録を、iPad／iPhoneの複数端末でリアルタイムに共有できるアプリです。
既存の「月間セッション目標管理」アプリ（ルートフォルダ）とは別の独立したアプリとして、この `training/` フォルダに作ってあります。

## できること
- 会員のプロフィール登録・編集・削除、名前検索、名前順／直近の記録順での並び替え
- 2名以上の会員を「ペア」として紐付け、トレーニング記録を同時入力
- 体重・体脂肪・体内年齢・筋肉量を記録し、それぞれ折れ線グラフで推移を確認
- セッション（1回目、2回目…）ごとにトレーニング種目・重量・回数をセット単位で記録
- 種目はマスタ管理で自由に追加・編集・削除可能
- 種目ごとの「重量・回数」の推移グラフ
- Supabaseを使い、iPad／iPhone間でデータをリアルタイム同期

## できないこと（現時点の制限）
- **オフライン入力・自動同期には対応していません。** 通信が切れている間は保存できません（Wi-Fi/モバイル回線が必要です）。
- ログイン機能はありません（下記「セキュリティについて」を参照）。

## セットアップ手順（初回のみ）

### 1. Supabaseプロジェクトを作成する
1. https://supabase.com にアクセスし、無料アカウントを作成
2. 「New project」でプロジェクトを作成（データベースのパスワードを設定し、忘れないよう保管してください）

### 2. データベースのテーブルを作成する
1. 作成したプロジェクトの左メニューから「SQL Editor」を開く
2. このフォルダの `supabase-schema.sql` の中身をすべてコピーして貼り付け、「Run」を実行
3. エラーが出なければ完了です

### 3. 接続情報をアプリに設定する
1. Supabase管理画面の左メニュー「Project Settings」→「API」を開く
2. 「Project URL」と「anon public」キーをコピー
3. このフォルダの `config.js` を開き、以下の2箇所を書き換えて保存
   ```js
   SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
   SUPABASE_ANON_KEY: 'xxxxxxxx...',
   ```

### 4. GitHub Pagesで公開する
ルートの `README.md` と同じ手順でGitHub Pagesを有効にしている場合、
`https://<ユーザー名>.github.io/bug-workspace/training/` でこのアプリにアクセスできます。
Safariの共有ボタン→「ホーム画面に追加」で、アプリのように使えます。

## セキュリティについて（重要）
このアプリはトレーナーおひとりでの利用を想定し、ログイン機能を持たせず「URLとanon keyを知っている人だけが使える」というシンプルな作りにしています。
- GitHub PagesのURLや `config.js` の中身（anon key）を、会員や第三者に共有しないでください。
- 会員の氏名・身体データなど個人情報を扱うため、取り扱いには注意してください。
- もしパスワードによるログインが必要になった場合はご相談ください（Supabase Authを使って追加できます）。

## ファイル構成
- `index.html` … 画面構成
- `style.css` … デザイン（ルートの `style.css` の色・ボタンなどを継承）
- `app.js` … Supabaseとの通信・画面のロジック
- `config.js` … Supabaseの接続設定（あなたのプロジェクトの値に書き換える）
- `supabase-schema.sql` … データベースのテーブル定義（初回にSupabase側で実行）
- `manifest.json` / `icon.svg` … ホーム画面追加用アイコン設定

## データ構造
- `members`（会員）: id, name, height, goal, pair_group_id
- `body_records`（身体データ）: id, member_id, date, weight, body_fat, body_age, muscle_mass, note
- `exercises`（種目マスタ）: id, name
- `training_sessions`（セッション）: id, member_id, date, session_no
- `training_records`（種目ごとの記録）: id, session_id, exercise_id, set_no, weight, reps

ペア機能は、紙のフォーマットにある「pair_id」を発展させ、同じ `pair_group_id` を持つ会員同士を
ペア（3人以上のグループも可）として扱う方式にしています。
