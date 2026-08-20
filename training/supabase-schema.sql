-- BUG トレーニング記録アプリ用 Supabase スキーマ
-- Supabaseの「SQL Editor」にこの内容を貼り付けて実行してください。
-- （実行は1回だけでOKです。すでにテーブルがある場合は if not exists により安全にスキップされます）

create extension if not exists "pgcrypto";

-- 会員
create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  height numeric,
  goal text,
  pair_group_id uuid,
  created_at timestamptz not null default now()
);

-- 身体データ（体重・体脂肪・体内年齢・筋肉量）
create table if not exists body_records (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members(id) on delete cascade,
  date date not null,
  weight numeric,
  body_fat numeric,
  body_age numeric,
  muscle_mass numeric,
  note text,
  created_at timestamptz not null default now()
);

-- 種目マスタ
create table if not exists exercises (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

-- トレーニングセッション（会員ごとの「◯回目」）
create table if not exists training_sessions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members(id) on delete cascade,
  date date not null,
  session_no integer not null,
  created_at timestamptz not null default now()
);

-- 種目ごとの記録（セット単位）
create table if not exists training_records (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references training_sessions(id) on delete cascade,
  exercise_id uuid not null references exercises(id) on delete cascade,
  set_no integer not null,
  weight numeric,
  reps integer,
  created_at timestamptz not null default now()
);

create index if not exists idx_body_records_member on body_records(member_id, date);
create index if not exists idx_training_sessions_member on training_sessions(member_id, date);
create index if not exists idx_training_records_session on training_records(session_id);

-- リアルタイム同期（iPad/iPhone間でデータ変更を即座に反映するため）
alter publication supabase_realtime add table members, body_records, exercises, training_sessions, training_records;

-- Row Level Security
-- このアプリはトレーナー1人での利用を想定し、ログイン機能を持たせず
-- 「発行したURL＋anon keyを知っている人だけが使える」というシンプルな運用にしています。
-- そのため下記のポリシーは「anonキーでの全操作を許可」としています。
-- 会員の個人情報を扱うため、GitHub PagesのURLや設定値は第三者に共有しないでください。
alter table members enable row level security;
alter table body_records enable row level security;
alter table exercises enable row level security;
alter table training_sessions enable row level security;
alter table training_records enable row level security;

drop policy if exists "allow all - members" on members;
create policy "allow all - members" on members for all using (true) with check (true);

drop policy if exists "allow all - body_records" on body_records;
create policy "allow all - body_records" on body_records for all using (true) with check (true);

drop policy if exists "allow all - exercises" on exercises;
create policy "allow all - exercises" on exercises for all using (true) with check (true);

drop policy if exists "allow all - training_sessions" on training_sessions;
create policy "allow all - training_sessions" on training_sessions for all using (true) with check (true);

drop policy if exists "allow all - training_records" on training_records;
create policy "allow all - training_records" on training_records for all using (true) with check (true);
