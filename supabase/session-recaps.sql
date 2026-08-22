-- Chips — the game-over recap: one short piece of writing per finished session.
--
-- Run this AFTER chips-schema.sql. Safe to re-run.
--
-- The row is CLAIMED before generation and filled in afterwards. Two people on the
-- game-over screen at the same moment would otherwise each start a generation; the
-- primary key makes the second insert fail, and that failure is the signal to wait
-- for the first one's text rather than pay for a second copy of it.

create table if not exists session_recaps (
  session_id   uuid primary key references sessions (id) on delete cascade,

  -- Null while a generation is in flight. A row that stays null means the attempt
  -- died; api/recap.js deletes its own claim on failure so the next visit retries.
  recap        text,
  claimed_at   timestamptz not null default now(),
  generated_at timestamptz
);

alter table session_recaps enable row level security;

drop policy if exists "session_recaps are public" on session_recaps;
create policy "session_recaps are public" on session_recaps
  for all using (true) with check (true);

grant select, insert, update, delete on session_recaps to anon, authenticated, service_role;
