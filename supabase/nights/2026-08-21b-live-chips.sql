-- Chips — the night of 2026-08-21, SECOND session, played with physical chips.
--
-- Seven seats at 1000 each, 10/20, no rebuys. The late game after the nine-hander
-- earlier the same evening (2026-08-21-live-chips.sql), so it is timestamped
-- 23:15 to sit after that session's 19:00-23:00. Generated from
-- supabase/manual-session.sql; kept here as the only record of these numbers.
--
-- THIS ONE BALANCES ON ITS OWN. 7000 bought in, 7000 counted out, zero drift.
-- Nothing is allocated and no net here is anything but a real count — unlike the
-- earlier session that night, where 30 chips had to be credited to square the
-- books. Read this night's numbers at face value.
--
--   player                     stack     net   net_bb
--   Jun                         1790    +790   +39.50
--   Chong                       1530    +530   +26.50
--   Keogan                      1420    +420   +21.00
--   Adam                        1120    +120    +6.00
--   Jack Aiden Hinderager        680    -320   -16.00
--   NK                           440    -560   -28.00
--   so did he embodies            20    -980   -49.00
--                               ----    ----
--                               7000       0
--
-- Every seat is pinned by identity id. "Jack" is stored as "Jack Aiden
-- Hinderager", which is a fair illustration of why nothing here resolves a seat
-- by the name people say at the table.
--
-- The guard finds its session by exact created_at, NOT by "the newest LIVECHIPS".
-- Three sessions now share that join code and a date-ordered lookup would check
-- whichever happened to sort last — which, for a second game on the same night,
-- is a coin flip. `select ... into strict` also makes a missing or ambiguous
-- match an error rather than a silent null.
--
-- Timestamps are -06 (MDT). A -06 evening renders as the next day's date in a
-- UTC session; that is display only, and the chart orders on the timestamp.
--
-- Run the whole file at once. Expect "NOTICE: OK — 7 seats, no duplicates, zero
-- drift" — it either commits seven balanced seats or rolls back leaving nothing.
--
-- Verified against a local Postgres 16 loaded from chips-schema.sql, seeded with
-- the ten real identities AND both earlier LIVECHIPS nights as decoys: the happy
-- path commits seven seats at zero drift; a wrong uuid aborts without disturbing
-- either decoy; the three nights compose correctly in lifetime_stats.

begin;

with night(identity_id, buyin, stack) as (values
  ('4998c517-c0fe-411b-afbb-7712d8933ded'::uuid, 1000, 1790),  -- Jun
  ('f7707ac9-6de6-4bb2-aec9-c52c4f4252fd'::uuid, 1000, 1530),  -- Chong
  ('29443ca8-d9c4-4497-942b-6f3e2a98ca4b'::uuid, 1000, 1420),  -- Keogan
  ('62e20319-e5a6-4621-8c88-ebaf52595456'::uuid, 1000, 1120),  -- Adam
  ('72a3c709-8bf5-4b62-aa0c-e5a8890890c6'::uuid, 1000,  680),  -- Jack Aiden Hinderager
  ('d6c7d730-458b-4fec-b973-44e66b1e0480'::uuid, 1000,  440),  -- NK
  ('8986ead2-b452-4e57-b6f9-d73f9f2cc96d'::uuid, 1000,   20)   -- so did he embodies
),
new_session as (
  insert into sessions (
    join_code, status, game_mode, small_blind, big_blind, starting_stack,
    blind_schedule, created_at, last_active_at
  )
  select 'LIVECHIPS', 'ended', 'cash', 10, 20, 1000, '[]'::jsonb,
         timestamptz '2026-08-21 23:15-06',
         timestamptz '2026-08-22 02:30-06'
  returning id
)
insert into players (
  session_id, identity_id, display_name, stack, total_buyin,
  is_host, is_active, folded, seat_order
)
select
  ns.id, pi.id, pi.display_name, n.stack, n.buyin,
  false, false, false,
  (row_number() over (order by n.stack desc))::int - 1
from night n
join players_identity pi on pi.id = n.identity_id
cross join new_session ns;

do $$
declare sid uuid; seats int; drift int; dupes int;
begin
  -- Pinned to this night's exact created_at, not "the newest LIVECHIPS". Three
  -- sessions now share that join code and a date-ordered lookup would silently
  -- check the wrong one.
  select id into strict sid from sessions
   where created_at = timestamptz '2026-08-21 23:15-06';
  select count(*), sum(stack) - sum(total_buyin) into seats, drift
    from players where session_id = sid;
  select count(*) into dupes from (
    select identity_id from players where session_id = sid
     group by identity_id having count(*) > 1) d;
  if seats <> 7 then
    raise exception 'expected 7 seats, inserted % — an identity id did not match', seats;
  end if;
  if dupes > 0 then
    raise exception '% identity id(s) listed twice', dupes;
  end if;
  if drift <> 0 then
    raise exception 'books do not balance: drift %', drift;
  end if;
  raise notice 'OK — 7 seats, no duplicates, zero drift';
end $$;

commit;
