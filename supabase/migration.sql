-- BUG泡瀬店 セッション目標管理アプリ用 追加設定
-- Supabaseダッシュボード → 対象プロジェクト → 左メニュー「SQL Editor」→「New query」に
-- この内容を貼り付けて「Run」を押してください（上から下まで一度に実行してOKです）。

-- 1) 既存の members テーブルに、アプリで使う列を追加します
--    （すでに存在する列はそのまま。なければ追加、という安全な書き方です）
alter table public.members
  add column if not exists weekly_sessions int8 not null default 0,
  add column if not exists monthly_target int8 not null default 0,
  add column if not exists completed_sessions int8 not null default 0,
  add column if not exists booked_sessions int8 not null default 0,
  add column if not exists remaining_contract int8 not null default 0,
  add column if not exists memo text not null default '';

-- 2) 「実施日」「予約日」を1件ずつ記録するテーブルを新規作成します
--    （週ごとの実績・過去月の実績を正しく計算するために必要です）
create table if not exists public.session_logs (
  id bigint generated always as identity primary key,
  member_id int8 not null references public.members(id) on delete cascade,
  session_date date not null,
  type text not null check (type in ('done', 'booked')),
  created_at timestamptz not null default now()
);

create index if not exists session_logs_member_id_idx on public.session_logs (member_id);
create index if not exists session_logs_date_idx on public.session_logs (session_date);

-- 2-1) 予約の「時間」を記録できるように列を追加します（任意項目。すでにあれば何もしません）
alter table public.session_logs
  add column if not exists session_time time;

-- 2-2) 会員の「コース」（契約セッション数の区分）を記録できるように列を追加します
--      値は 8 / 24 / 48 を想定していますが、列自体はどの数値も許容します（空でも構いません）
alter table public.members
  add column if not exists course_sessions int8;

-- 3) Row Level Security（行レベルセキュリティ）を有効化します
--    このアプリはログイン機能を持たないため、匿名キー(anon key)からの読み書きを許可します。
--    ※ URLとanonキーを知っている人なら誰でもデータの閲覧・変更ができる状態になる点にご注意ください。
--       院内・店舗内のみで使う想定でなければ、後日 Supabase Auth を使ったログイン機能の追加をおすすめします。
alter table public.members enable row level security;
alter table public.session_logs enable row level security;

drop policy if exists "Allow anon full access to members" on public.members;
create policy "Allow anon full access to members" on public.members
  for all
  to anon
  using (true)
  with check (true);

drop policy if exists "Allow anon full access to session_logs" on public.session_logs;
create policy "Allow anon full access to session_logs" on public.session_logs
  for all
  to anon
  using (true)
  with check (true);

-- 4) Googleカレンダー連携: 同期済みのイベントIDを記録する列を追加します（任意項目）
--    Google Apps Scriptが、この記録と対応するカレンダーの予定を突き合わせるために使います。
alter table public.session_logs
  add column if not exists calendar_event_id text;

-- 5) 月次レポート（オーナーMTG用）: 会員のランクを記録できるようにします（任意項目。SS/S/A/B/C想定）
alter table public.members
  add column if not exists rank text;

-- 6) 月次レポート（オーナーMTG用）: 月ごとに手入力する数値（売上・新規獲得経路・カウンセリング・サプリメント）を保存するテーブル
create table if not exists public.monthly_reports (
  id bigint generated always as identity primary key,
  month text not null unique, -- 'YYYY-MM'
  revenue_target int8 not null default 0,
  revenue_actual int8 not null default 0,
  new_member_target int8 not null default 0,
  new_lp int8 not null default 0,
  new_instagram int8 not null default 0,
  new_threads int8 not null default 0,
  new_referral int8 not null default 0,
  new_other int8 not null default 0,
  counseling_actual int8 not null default 0,
  supplement_actual int8 not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.monthly_reports enable row level security;

drop policy if exists "Allow anon full access to monthly_reports" on public.monthly_reports;
create policy "Allow anon full access to monthly_reports" on public.monthly_reports
  for all
  to anon
  using (true)
  with check (true);

-- 7) 月次レポートを「週ごと（1〜5週目）」の入力に対応させます
--    数値がかなり増えるため、個別の列ではなく1つのJSON列（weekly_data）にまとめて保存する形に変更します。
--    （6番で作った列はまだ本番で使われていないため、そのまま入れ替えて問題ありません）
alter table public.monthly_reports
  drop column if exists revenue_target,
  drop column if exists revenue_actual,
  drop column if exists new_member_target,
  drop column if exists new_lp,
  drop column if exists new_instagram,
  drop column if exists new_threads,
  drop column if exists new_referral,
  drop column if exists new_other,
  drop column if exists counseling_actual,
  drop column if exists supplement_actual;

alter table public.monthly_reports
  add column if not exists weekly_data jsonb not null default '{}'::jsonb,
  add column if not exists mt_retro text not null default '';
