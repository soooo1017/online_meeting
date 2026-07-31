-- Supabase 대시보드 > SQL Editor 에서 실행하세요.
-- 미팅 기록(이름/시작·종료 시각/참여자 닉네임)만 남기는 테이블입니다.
-- 영상/음성은 여전히 어디에도 저장되지 않습니다.

create table if not exists meetings (
  id uuid primary key default gen_random_uuid(),
  room_name text not null,
  room_code text not null,
  meeting_date date not null default current_date,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  participants text[] not null default '{}'
);

alter table meetings enable row level security;

-- 계정/로그인 시스템이 없는 앱이라, 익명 키로 자유롭게 남기고 읽을 수 있게 둡니다.
create policy "anyone can insert meetings" on meetings
  for insert
  with check (true);

create policy "anyone can select meetings" on meetings
  for select
  using (true);

create policy "anyone can update meetings" on meetings
  for update
  using (true);

-- ---------------------------------------------------------------
-- 이미 meetings 테이블을 만드셨다면, 위 create table은 그냥 넘어가고
-- (if not exists라 에러 안 남) 아래 한 줄만 실행하시면 meeting_date 컬럼이 추가돼요.
-- 다만 새 컬럼은 테이블 맨 뒤에 붙기 때문에, started_at 앞에 보이게 하고 싶으시면
-- Table Editor에서 meeting_date 컬럼을 드래그해서 순서만 옮겨주시면 됩니다.
-- ---------------------------------------------------------------
-- alter table meetings add column if not exists meeting_date date;
