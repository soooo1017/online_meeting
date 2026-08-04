-- Supabase 대시보드 > SQL Editor 에서 실행하세요.
-- "방 만들기"를 아무나 못 하게 막고, 미리 발급한 6자리 코드를 가진 사람만
-- 방을 만들 수 있게 하기 위한 테이블입니다. (참여하기는 코드 없이 누구나 가능)
--
-- 이 스크립트는 몇 번을 다시 실행해도 안전합니다.
--
-- ---- 코드를 발급/관리하는 방법 ----
-- Supabase 대시보드 > Table Editor > creator_codes 테이블에서 "Insert row"로 행을
-- 추가하면 됩니다. id 칸은 비워두세요(uuid가 자동으로 채워집니다 — 직접 숫자를
-- 입력하면 "invalid input syntax for type uuid" 오류가 납니다). code에는 6자리
-- 숫자(예: "482913")를, label에는 누구에게 준 코드인지 알아보기 쉽게 메모(예: "민수")를
-- 적어두면 나중에 관리하기 편합니다. created_at도 비워두면 자동으로 지금 시각이 들어갑니다.
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

-- 예전에는 "select만 열어두고 code로 필터링해서 조회"하는 방식이었는데, 이러면
-- 익명 키만 있으면(웹사이트를 한 번이라도 방문했다면 누구나 가진) REST API로
-- creator_codes 테이블에 직접 select=code 요청을 보내 코드 전체 목록을 그대로
-- 가져갈 수 있었습니다 — "방 만들기" 게이트가 사실상 무력화되는 문제였습니다.
-- 이제는 익명 키로는 이 테이블을 아예 직접 조회할 수 없게 select 정책을 두지
-- 않고(= 기본적으로 전부 거부), 코드가 맞는지 확인하는 건 아래
-- verify_creator_code 함수 하나만 거치도록 합니다. 코드 추가/삭제는 여전히
-- Supabase 대시보드(관리자만 접근 가능)에서 하므로 insert/update/delete 정책도 없습니다.
drop policy if exists "anyone can select creator_codes" on creator_codes;

-- security definer로 만들어서, 이 함수를 만든 소유자(postgres, 즉 creator_codes의
-- 테이블 소유자와 동일)의 권한으로 실행됩니다 — RLS를 우회해 테이블을 직접 볼 수
-- 있지만, 바깥으로는 "코드가 존재하는지(true/false)"만 돌려주고 실제 코드 목록이나
-- label 같은 값은 절대 내보내지 않습니다.
create or replace function public.verify_creator_code(p_code text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from creator_codes where code = p_code
  );
$$;

revoke all on function public.verify_creator_code(text) from public;
grant execute on function public.verify_creator_code(text) to anon, authenticated;
