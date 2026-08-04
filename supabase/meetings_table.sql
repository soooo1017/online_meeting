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

-- 공개 미팅 목록 기능용 컬럼.
-- is_public: 방장이 "공개"를 선택했는지 (첫 화면 미팅 목록에 표시할지)
-- password: 실제 비밀번호 값. 익명 키로는 이 컬럼을 select할 수 없도록 아래에서
--   컬럼 단위 권한을 따로 걸어두었고, 일치 여부 확인은 verify_room_password
--   함수로만 합니다 (틀린 값이면 false만 돌아올 뿐, 진짜 비밀번호가 뭔지는 알려주지 않음).
-- has_password: 목록 화면에 "프라이빗/퍼블릭" 표시만 하기 위한 값(진짜 비밀번호는 노출 안 함).
-- host_nickname: 목록에 "누가 연 방인지" 보여주기 위한 값.
alter table meetings add column if not exists is_public boolean not null default false;
alter table meetings add column if not exists password text;
alter table meetings add column if not exists has_password boolean not null default false;
alter table meetings add column if not exists host_nickname text;

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

-- ---- password 컬럼은 select 정책과 별개로 컬럼 단위 권한을 걸어 숨깁니다 ----
-- 위 select 정책(using(true))은 "어떤 행"을 볼 수 있는지만 정할 뿐, "어떤 컬럼"을
-- 볼 수 있는지는 별개입니다. 예전에는 password 컬럼도 다른 컬럼과 함께 그냥
-- select 가능했는데, 이러면 익명 키만 있으면(웹사이트를 한 번이라도 방문했다면
-- 누구나 가진) REST API로 meetings에 직접 select=password 요청을 보내 모든 방의
-- 평문 비밀번호를 그대로 가져갈 수 있었습니다. 아래처럼 select 가능한 컬럼 목록을
-- password를 뺀 나머지로 명시하면, password를 select 절이나 where 절 어디에
-- 쓰려고 해도(기존 방식대로 .eq("password", ...)로 필터링하는 것 포함) 권한 오류로
-- 막힙니다 — 비밀번호가 맞는지 확인하는 건 아래 verify_room_password 함수 하나만
-- 거치도록 합니다.
revoke select on meetings from anon, authenticated;
grant select (
  id, room_name, room_code, started_at, ended_at, participants,
  meeting_date, last_active_at, is_public, has_password, host_nickname
) on meetings to anon, authenticated;

-- security definer로 만들어서, 이 함수를 만든 소유자(postgres, 즉 meetings의 테이블
-- 소유자와 동일)의 권한으로 실행됩니다 — RLS/컬럼 권한을 우회해 password 컬럼을
-- 직접 비교할 수 있지만, 바깥으로는 "비밀번호가 맞는지(true/false)"만 돌려주고
-- 실제 비밀번호 값은 절대 내보내지 않습니다.
create or replace function public.verify_room_password(p_room_code text, p_password text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from meetings
    where room_code = p_room_code
      and password = p_password
      and ended_at is null
  );
$$;

revoke all on function public.verify_room_password(text, text) from public;
grant execute on function public.verify_room_password(text, text) to anon, authenticated;
