-- Supabase 대시보드 > SQL Editor 에서 실행하세요.
-- 미팅 기록(이름/시작·종료 시각/참여자 닉네임)만 남기는 테이블입니다.
-- 영상/음성은 여전히 어디에도 저장되지 않습니다.
--
-- 이 스크립트는 몇 번을 다시 실행해도 안전합니다 (테이블/컬럼이 이미 있으면 건너뛰고,
-- 정책은 지웠다가 다시 만듭니다). 예전에 일부만 실행했었더라도 그냥 전체를 다시
-- 실행하시면 현재 상태로 맞춰집니다.

create table if not exists meetings (
  id uuid primary key default gen_random_uuid(),
  room_name text not null,
  room_code text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  participants text[] not null default '{}'
);

alter table meetings add column if not exists meeting_date date not null default current_date;
alter table meetings add column if not exists last_active_at timestamptz not null default now();

alter table meetings enable row level security;

-- 계정/로그인 시스템이 없는 앱이라, 익명 키로 자유롭게 남기고 읽을 수 있게 둡니다.
drop policy if exists "anyone can insert meetings" on meetings;
create policy "anyone can insert meetings" on meetings
  for insert
  with check (true);

drop policy if exists "anyone can select meetings" on meetings;
create policy "anyone can select meetings" on meetings
  for select
  using (true);

drop policy if exists "anyone can update meetings" on meetings;
create policy "anyone can update meetings" on meetings
  for update
  using (true);
