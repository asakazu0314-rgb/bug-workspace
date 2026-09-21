// Supabaseの接続設定
// Supabaseダッシュボード → 対象プロジェクト → 左メニュー「Project Settings」→「Data API」で確認できます。
// - url: 「Project URL」（例: https://xxxxxxxxxxxx.supabase.co）
// - anonKey: 「anon public」キー（「Project API keys」に表示されています）
//
// この anonKey は公開されても問題ない前提のキーです（Supabaseの仕組み上、
// アクセス制御はデータベース側の Row Level Security で行います）。
// ただし service_role キー（管理者用の強い権限を持つキー）は絶対にここに書かないでください。

window.SUPABASE_CONFIG = {
  url: 'https://rnkucsdsdwyjxevxwmcl.supabase.co',
  anonKey: 'sb_publishable_jnKFKZpuqrjB1Psp3pljEA_lquY5M-D',
  // 任意設定：Googleカレンダー連携（calendar-sync）をウェブアプリとして公開した際のURL。
  // 設定すると、CSVアップロード完了時にその場でカレンダーへ反映されます（未設定でも1日5回の自動同期は動きます）。
  // 手順は calendar-sync/README.md を参照してください。
  calendarSyncUrl: 'https://script.google.com/macros/s/AKfycbx1srt1zjOW-ZPnqK7cuHDk3cDJbko8PX1_qnkgKs8wuoWtoT7SikQPmKLCjjUy-hY6/exec',
};
