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

-- 4) Gyms連携: 会員とGymsの顧客IDを紐付ける列を追加します（任意項目）
--    一度会員名で自動的に紐付けが成功したら、以降はこの顧客IDで確実に照合できるようにします
alter table public.members
  add column if not exists gyms_customer_id text;

create unique index if not exists members_gyms_customer_id_idx
  on public.members (gyms_customer_id)
  where gyms_customer_id is not null;

-- 5) Gyms連携: 自動反映できなかった予約通知を記録するテーブルを新規作成します
--    （会員名が一致しない、対象の予約が見つからない、などの場合にここへ記録され、
--      アプリの「Gyms確認」タブで内容を確認できます）
create table if not exists public.gyms_unmatched_events (
  id bigint generated always as identity primary key,
  event_type text not null check (event_type in ('booking', 'cancel', 'change')),
  reason text not null,
  customer_name text not null,
  gyms_customer_id text,
  scheduled_date date,
  scheduled_time time,
  old_scheduled_date date,
  old_scheduled_time time,
  raw_subject text,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists gyms_unmatched_events_resolved_idx
  on public.gyms_unmatched_events (resolved);

-- 6) Gyms連携: 処理済みメールを記録し、同じメールを二重に反映しないようにするテーブルです
create table if not exists public.gyms_processed_messages (
  gmail_message_id text primary key,
  processed_at timestamptz not null default now()
);

alter table public.gyms_unmatched_events enable row level security;
alter table public.gyms_processed_messages enable row level security;

drop policy if exists "Allow anon full access to gyms_unmatched_events" on public.gyms_unmatched_events;
create policy "Allow anon full access to gyms_unmatched_events" on public.gyms_unmatched_events
  for all
  to anon
  using (true)
  with check (true);

drop policy if exists "Allow anon full access to gyms_processed_messages" on public.gyms_processed_messages;
create policy "Allow anon full access to gyms_processed_messages" on public.gyms_processed_messages
  for all
  to anon
  using (true)
  with check (true);
