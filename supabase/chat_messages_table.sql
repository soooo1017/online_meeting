-- Supabase 대시보드 > SQL Editor 에서 실행하세요.
-- 미팅 진행 중에 오간 채팅을, 중간에 들어오거나 새로고침해도 이어서 볼 수 있도록
-- 잠깐 저장해두는 테이블입니다. meetings 테이블과 달리 영구 보관용이 아니라, 미팅이
-- 끝나면(ended_at이 찍히는 시점) room.js가 이 테이블에서 해당 미팅의 채팅을 바로
-- 지웁니다 — 즉 미팅이 진행되는 동안에만 유지되고, 끝나면 사라집니다.
--
-- 이 스크립트는 몇 번을 다시 실행해도 안전합니다.

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null,
  sender_client_id text not null,
  sender_nickname text not null,
  text text not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_meeting_id_idx on chat_messages (meeting_id);

alter table chat_messages enable row level security;

-- 계정/로그인 시스템이 없는 앱이라, 익명 키로 자유롭게 남기고 읽고(미팅 중인 사람만
-- meeting_id를 알 수 있음) 지울 수 있게 둡니다(미팅 종료 시 정리용).
drop policy if exists "anyone can insert chat_messages" on chat_messages;
create policy "anyone can insert chat_messages" on chat_messages
  for insert
  with check (true);

drop policy if exists "anyone can select chat_messages" on chat_messages;
create policy "anyone can select chat_messages" on chat_messages
  for select
  using (true);

drop policy if exists "anyone can delete chat_messages" on chat_messages;
create policy "anyone can delete chat_messages" on chat_messages
  for delete
  using (true);
