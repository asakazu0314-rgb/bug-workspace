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

-- =========================================================
-- 4) 食事サポート管理機能（会員プロフィール／経緯／LINEトーク履歴／食事報告）
--    既存テーブルのデータは一切削除・変更しません（追加のみ）。
-- =========================================================

-- 4-1) 会員ごとの食事サポート用プロフィール（1会員につき1行）
create table if not exists public.meal_profiles (
  member_id int8 primary key references public.members(id) on delete cascade,
  purpose text, -- 減量 / 増量 / 健康改善 / 筋力アップ / その他
  current_weight numeric,
  target_weight numeric,
  height numeric,
  meals_per_day int8,
  meal_policy text,
  current_rules text,
  staple_amount text,
  protein_guidance text,
  fat_guidance text,
  vegetable_guidance text,
  daily_rhythm text,
  occupation text,
  exercise_frequency text,
  trainer_cautions text,
  member_weak_points text,
  diet_history text,
  other_background text,
  trainer_notes text,
  updated_at timestamptz not null default now()
);

-- 4-2) 会員様の経緯（トレーナーが自由記述、日付＋内容）
create table if not exists public.meal_notes (
  id bigint generated always as identity primary key,
  member_id int8 not null references public.members(id) on delete cascade,
  note_date date not null,
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists meal_notes_member_id_idx on public.meal_notes (member_id);
create index if not exists meal_notes_note_date_idx on public.meal_notes (note_date);

-- 4-3) LINEユーザー（LINE user ID と会員の紐付け。未紐付けは member_id が空のまま）
create table if not exists public.line_users (
  line_user_id text primary key,
  member_id int8 references public.members(id) on delete set null,
  display_name text,
  linked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists line_users_member_id_idx on public.line_users (member_id);

-- 4-4) LINEトーク履歴（本番連携前は手動追加でテスト、連携後はWebhookから自動保存）
create table if not exists public.line_messages (
  id bigint generated always as identity primary key,
  member_id int8 references public.members(id) on delete set null,
  line_user_id text references public.line_users(line_user_id) on delete set null,
  sent_at timestamptz not null default now(),
  sender text not null check (sender in ('member', 'trainer')),
  message_type text not null check (message_type in ('text', 'image')),
  body text,
  line_message_id text,
  image_path text,
  is_confirmed boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists line_messages_member_id_idx on public.line_messages (member_id);
create index if not exists line_messages_sent_at_idx on public.line_messages (sent_at);

-- 4-5) 食事報告（トーク履歴の中から「食事報告」として扱う単位。Claude用プロンプトや
--      FB（AI生成・トレーナー修正・実際に送信）はここに保存する）
create table if not exists public.meal_reports (
  id bigint generated always as identity primary key,
  member_id int8 not null references public.members(id) on delete cascade,
  line_message_id int8 references public.line_messages(id) on delete set null,
  reported_at timestamptz not null default now(),
  meal_label text,
  member_text text,
  has_image boolean not null default false,
  image_path text,
  ai_feedback text,
  trainer_feedback text,
  sent_feedback text,
  is_confirmed boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists meal_reports_member_id_idx on public.meal_reports (member_id);
create index if not exists meal_reports_reported_at_idx on public.meal_reports (reported_at);

-- 4-6) 食事の写真を保存するストレージ（画像バケット）
--      公開バケットにして、アプリからそのままURLで表示できるようにします
insert into storage.buckets (id, name, public)
values ('meal-images', 'meal-images', true)
on conflict (id) do nothing;

-- 4-7) 上記テーブル・ストレージの Row Level Security を、既存テーブルと同じ方針
--      （ログイン機能がないため anon キーからの読み書きを許可）で設定します
alter table public.meal_profiles enable row level security;
alter table public.meal_notes enable row level security;
alter table public.line_users enable row level security;
alter table public.line_messages enable row level security;
alter table public.meal_reports enable row level security;

drop policy if exists "Allow anon full access to meal_profiles" on public.meal_profiles;
create policy "Allow anon full access to meal_profiles" on public.meal_profiles
  for all to anon using (true) with check (true);

drop policy if exists "Allow anon full access to meal_notes" on public.meal_notes;
create policy "Allow anon full access to meal_notes" on public.meal_notes
  for all to anon using (true) with check (true);

drop policy if exists "Allow anon full access to line_users" on public.line_users;
create policy "Allow anon full access to line_users" on public.line_users
  for all to anon using (true) with check (true);

drop policy if exists "Allow anon full access to line_messages" on public.line_messages;
create policy "Allow anon full access to line_messages" on public.line_messages
  for all to anon using (true) with check (true);

drop policy if exists "Allow anon full access to meal_reports" on public.meal_reports;
create policy "Allow anon full access to meal_reports" on public.meal_reports
  for all to anon using (true) with check (true);

drop policy if exists "Allow anon full access to meal-images" on storage.objects;
create policy "Allow anon full access to meal-images" on storage.objects
  for all to anon
  using (bucket_id = 'meal-images')
  with check (bucket_id = 'meal-images');
