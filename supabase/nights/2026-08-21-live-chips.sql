-- Chips — the night of 2026-08-21, played with physical chips.
--
-- Nine seats at 1000 each, 10/20, no rebuys. Generated from
-- supabase/manual-session.sql; see that file for what the blocks do and why.
-- Kept here as the only record of where these numbers came from.
--
-- THE COUNT DID NOT BALANCE, AND 30 CHIPS HERE ARE ALLOCATED, NOT COUNTED.
--
-- The stacks as counted came to 8970 against 9000 bought in — 30 short. On the
-- account owner's instruction the shortfall is credited to everyone except
-- Keogan and NK, seven players, at 4 each. 30 does not divide by 7, so the
-- remaining 2 went to the two largest stacks (Jun and Owen), on the reasoning
-- that a big stack has more chips to miscount than a small one. That choice is
-- a decision, not a derivation — the same footing as the leaver-mint remainder
-- in repairs/2026-08-14-endsession-over-refund.sql.
--
--   player                        counted   adj    stack     net
--   Jun                              1770    +5     1775    +775
--   Owen the great and wonderful     1750    +5     1755    +755
--   Emily                            1730    +4     1734    +734
--   Adam                             1320    +4     1324    +324
--   so did he embodies                690    +4      694    -306
--   Keogan                            590     -      590    -410
--   Lily                              580    +4      584    -416
--   Chong                             540    +4      544    -456
--   NK                                  0     -        0   -1000
--                                   -----   ---     ----    ----
--                                    8970   +30     9000       0
--
-- Anyone reading a net off this night is reading a number up to 5 chips kinder
-- than what was on the table. At 10/20 that is a quarter of a big blind, which
-- is why it was worth doing at all rather than leaving the session unbalanced.
--
-- Every seat is pinned by identity id, resolved through block 1 of
-- manual-session.sql. An earlier draft pinned only Owen — the name known to be
-- ambiguous — and resolved the rest by name; it aborted on Emily, who also had
-- a second identity. Duplicate display names are the norm here, so all nine are
-- pinned and none are looked up by name.
--
-- Owen's other three identities and Emily's second are husks: zero seats in any
-- ended session, so they never touched the leaderboard. Nothing was ever split
-- and nothing needs merging. To tidy them away (optional, and self-guarding —
-- the players.identity_id foreign key refuses to drop an identity that still
-- holds a seat, so this cannot delete anyone's history):
--
--   delete from players_identity where id in (
--     '0da7e3b8-1fad-4948-a19e-3f7650c4d2a5',   -- Owen husk
--     '4d5dbe5d-ed33-493e-9a2a-1d5190d5b750',   -- Owen husk
--     'f808ab32-ef3f-4f68-93f7-d973db1db821',   -- Owen husk
--     'a199c17a-eb51-42a4-a004-3f056cf1e0c1');  -- Emily husk
--
-- Timestamps are -06 (MDT). Nothing in the repo pins a timezone; created_at is
-- what orders the cumulative-net chart, so fix the offset if that is wrong.
-- Note that a -06 evening renders as the NEXT day's date in a UTC session --
-- that is display only, and the chart orders on the timestamp itself.
--
-- Run the whole file at once — it is one transaction with its own guards, and
-- either commits nine balanced seats or rolls back leaving nothing. Expect
-- "NOTICE: OK — 9 seats, no duplicates, zero drift".
--
-- Verified against a local Postgres 16 loaded from chips-schema.sql and seeded
-- with all thirteen real identity ids: the happy path commits nine seats at zero
-- drift, awarding times_first to Jun and times_last to NK; a wrong uuid aborts
-- naming the seat count; the same id listed twice aborts on the duplicate check;
-- neither leaves a partial session behind.

begin;

with night(identity_id, buyin, stack) as (values
  ('4998c517-c0fe-411b-afbb-7712d8933ded'::uuid, 1000, 1775),  -- Jun
  ('efbb9068-c837-4063-b2bf-1282e380e883'::uuid, 1000, 1755),  -- Owen the great and wonderful
  ('159b2e7b-61b8-4314-a6d2-4df66d050d56'::uuid, 1000, 1734),  -- Emily
  ('62e20319-e5a6-4621-8c88-ebaf52595456'::uuid, 1000, 1324),  -- Adam
  ('8986ead2-b452-4e57-b6f9-d73f9f2cc96d'::uuid, 1000,  694),  -- so did he embodies
  ('29443ca8-d9c4-4497-942b-6f3e2a98ca4b'::uuid, 1000,  590),  -- Keogan
  ('053b03ab-c089-4347-ab08-0492b39e68a6'::uuid, 1000,  584),  -- Lily
  ('f7707ac9-6de6-4bb2-aec9-c52c4f4252fd'::uuid, 1000,  544),  -- Chong
  ('d6c7d730-458b-4fec-b973-44e66b1e0480'::uuid, 1000,    0)   -- NK
),
new_session as (
  insert into sessions (
    join_code, status, game_mode, small_blind, big_blind, starting_stack,
    blind_schedule, created_at, last_active_at
  )
  select 'LIVECHIPS', 'ended', 'cash', 10, 20, 1000, '[]'::jsonb,
         timestamptz '2026-08-21 19:00-06',
         timestamptz '2026-08-21 23:00-06'
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
  select id into sid from sessions where join_code = 'LIVECHIPS'
   order by created_at desc limit 1;
  select count(*), sum(stack) - sum(total_buyin) into seats, drift
    from players where session_id = sid;
  select count(*) into dupes from (
    select identity_id from players where session_id = sid
     group by identity_id having count(*) > 1) d;
  if seats <> 9 then
    raise exception 'expected 9 seats, inserted % — an identity id did not match', seats;
  end if;
  if dupes > 0 then
    raise exception '% identity id(s) listed twice', dupes;
  end if;
  if drift <> 0 then
    raise exception 'books do not balance: drift %', drift;
  end if;
  raise notice 'OK — 9 seats, no duplicates, zero drift';
end $$;

commit;
