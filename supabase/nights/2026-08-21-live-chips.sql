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
-- Owen is pinned by id: "Owen the great and wonderful" resolves to four
-- identities and a name join would insert four seats. The other six names are
-- resolved by scalar subquery, which raises rather than fanning out if any of
-- them has picked up a duplicate too.
--
-- Timestamps are -06 (MDT). Nothing in the repo pins a timezone; created_at is
-- what orders the cumulative-net chart, so fix the offset if that is wrong.
--
-- Run the whole file at once — unlike the other scripts here it is one
-- transaction with its own guards, and it either commits nine balanced seats or
-- rolls back leaving nothing. Expect "NOTICE: OK — 9 seats, zero drift".
--
-- Verified against a local Postgres 16 loaded from chips-schema.sql, seeded with
-- a duplicated Owen: the happy path commits 9 seats at zero drift; a missing
-- identity aborts naming it; a duplicate name aborts on the scalar subquery; a
-- tampered stack aborts on the drift check. No partial session survives any of
-- them.

begin;

with night(pin, name, buyin, stack) as (values
  ('efbb9068-c837-4063-b2bf-1282e380e883'::uuid, 'Owen the great and wonderful', 1000, 1755),
  ('8986ead2-b452-4e57-b6f9-d73f9f2cc96d'::uuid, 'so did he embodies',           1000,  694),
  ('f7707ac9-6de6-4bb2-aec9-c52c4f4252fd'::uuid, 'Chong',                        1000,  544),
  (null,                                         'Jun',                          1000, 1775),
  (null,                                         'Emily',                        1000, 1734),
  (null,                                         'Adam',                         1000, 1324),
  (null,                                         'Keogan',                       1000,  590),
  (null,                                         'Lily',                         1000,  584),
  (null,                                         'NK',                           1000,    0)
),
resolved as (
  select
    n.name, n.buyin, n.stack,
    coalesce(
      n.pin,
      -- Scalar subquery on purpose: if this name has picked up more than one
      -- identity it raises "more than one row returned by a subquery used as an
      -- expression" and the whole transaction dies. That is the four-Owen bug
      -- failing loudly instead of silently inserting a seat per match.
      (select pi.id from players_identity pi
        where lower(pi.display_name) = lower(n.name))
    ) as identity_id
  from night n
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
  ns.id, pi.id, pi.display_name, r.stack, r.buyin,
  false, false, false,
  (row_number() over (order by pi.display_name))::int - 1
from resolved r
-- Inner join: an unresolved name drops its seat rather than inserting a
-- null-identity one, and the guard below then refuses to commit.
join players_identity pi on pi.id = r.identity_id
cross join new_session ns;

do $$
declare
  sid uuid;
  seats int;
  drift int;
  missing text;
begin
  select id into sid from sessions where join_code = 'LIVECHIPS'
   order by created_at desc limit 1;
  select count(*), sum(stack) - sum(total_buyin) into seats, drift
    from players where session_id = sid;
  if seats <> 9 then
    select string_agg(want.name, ', ') into missing
      from (values ('Owen the great and wonderful'),('so did he embodies'),
                   ('Chong'),('Jun'),('Emily'),('Adam'),('Keogan'),
                   ('Lily'),('NK')) as want(name)
     where not exists (
       select 1 from players p
        where p.session_id = sid and lower(p.display_name) = lower(want.name));
    raise exception 'expected 9 seats, inserted %. Unresolved: %',
      seats, coalesce(missing, '(none — a name resolved to someone unexpected)');
  end if;
  if drift <> 0 then
    raise exception 'books do not balance: drift %', drift;
  end if;
  raise notice 'OK — 9 seats, zero drift';
end $$;

commit;
