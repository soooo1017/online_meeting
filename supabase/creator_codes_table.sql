-- Supabase 대시보드 > SQL Editor 에서 실행하세요.
-- "방 만들기"를 아무나 못 하게 막고, 미리 발급한 5자리 코드를 가진 사람만
-- 방을 만들 수 있게 하기 위한 테이블입니다. (참여하기는 코드 없이 누구나 가능)
--
-- 이 스크립트는 몇 번을 다시 실행해도 안전합니다.
--
-- ---- 코드를 발급/관리하는 방법 ----
-- Supabase 대시보드 > Table Editor > creator_codes 테이블에서 직접 행을 추가/삭제하면
-- 됩니다. code에는 5자리 숫자(예: "48213")를, label에는 누구에게 준 코드인지
-- 알아보기 쉽게 메모(예: "민수")를 적어두면 나중에 관리하기 편합니다.
--
-- ---- 알아둘 점 ----
-- 이 앱은 별도 서버 없이 정적 페이지 + Supabase만으로 동작해서, 코드 검증도
-- 브라우저에서 Supabase에 직접 물어보는 방식입니다. 즉 "빠르게 남이 함부로 방을
-- 못 만들게 막는 가벼운 장치"이지, 마음먹고 우회하려는 사람까지 완벽히 막을 수
-- 있는 보안 장치는 아닙니다. 친구들끼리 쓰는 용도로는 충분합니다.

create table if not exists creator_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  label text,
  created_at timestamptz not null default now()
);

alter table creator_codes enable row level security;

-- 코드가 맞는지 확인하려면 조회는 되어야 하니 select만 열어둡니다. 코드 추가/삭제는
-- Supabase 대시보드(관리자만 접근 가능)에서 하므로 익명 키에는 insert/update/delete
-- 권한을 주지 않습니다.
drop policy if exists "anyone can select creator_codes" on creator_codes;
create policy "anyone can select creator_codes" on creator_codes
  for select
  using (true);
