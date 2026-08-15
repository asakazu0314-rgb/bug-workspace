// Supabaseの接続設定
// Supabaseダッシュボード → 対象プロジェクト → 左メニュー「Project Settings」→「Data API」で確認できます。
// - url: 「Project URL」（例: https://xxxxxxxxxxxx.supabase.co）
// - anonKey: 「anon public」キー（「Project API keys」に表示されています）
//
// この anonKey は公開されても問題ない前提のキーです（Supabaseの仕組み上、
// アクセス制御はデータベース側の Row Level Security で行います）。
// ただし service_role キー（管理者用の強い権限を持つキー）は絶対にここに書かないでください。

window.SUPABASE_CONFIG = {
  url: 'YOUR_SUPABASE_URL',
  anonKey: 'YOUR_SUPABASE_ANON_KEY',
};
