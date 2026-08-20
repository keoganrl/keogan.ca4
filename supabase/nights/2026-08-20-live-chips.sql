-- Chips — the night of 2026-08-20, played with physical chips.
--
-- Entered by hand from the cashout counts, because there is no ledger for this
-- one: nobody was on the app. Generated from supabase/manual-session.sql; see
-- that file for what each block is doing and why. Kept here as the only record
-- of where these numbers came from.
--
--   buy-in   1000 each, no rebuys
--   blinds   10/20  (so the buy-in was a 50bb stack)
--
--   Owen the great and wonderful   -340   →  660 back
--   so did he embodies             + 70   → 1070 back
--   Chong                          +270   → 1270 back
--                                 ------
--                                     0
--
-- Timestamps below are -06 (MDT). Nothing in the repo pins a timezone, so if
-- that's wrong for where this was played, fix the offset before running block 3
-- — created_at is what orders the cumulative-net chart.
--
-- Paste ONE BLOCK AT A TIME into the Supabase SQL editor. The editor only shows
-- the last statement's result, so running the file whole throws away the checks.


-- =====================================================================
-- 1. Do these three names resolve to the right people? — run first
-- =====================================================================
-- Changes nothing. Read every row before going on:
--
--   identity_id null       → no such player. Check the spelling against
--                            will_appear_as on a name you know is right; if
--                            they're genuinely new, block 4 creates them.
--   two rows for one name  → the same person exists as several identities. This
--                            is what happened here: Owen came back four times.
--                            Block 3 pins ids to cope with it; block 1b says
--                            whether the extras also need merging.
--   sessions_on_record 0   → suspicious for a regular. Usually means the name
--                            here isn't the one stored on their identity.
--
-- A miss here fails SILENTLY and badly, so don't skip this block. An unmatched
-- name still inserts a seat — the books still balance and query 0b stays quiet —
-- but with a null identity_id it drops out of both lifetime_stats and
-- session_results, so that player's night simply doesn't exist on the board.
-- It still counts as a seat for placements, though (session_extremes spans every
-- seat on purpose), so it goes on denying first or last to everyone else. Net
-- effect of one typo: the player loses the night, and the rest of the table gets
-- graded against a result nobody can see. Verified against this exact roster.

with night(name, buyin, net) as (values
  ('Owen the great and wonderful', 1000, -340),
  ('so did he embodies',           1000,   70),
  ('Chong',                        1000,  270)
)
select
  n.name,
  n.buyin,
  n.net,
  n.buyin + n.net                          as final_stack,
  pi.id                                    as identity_id,
  pi.display_name                          as will_appear_as,
  (select count(*) from players p where p.identity_id = pi.id) as sessions_on_record
from night n
left join players_identity pi on lower(pi.display_name) = lower(n.name)
order by n.name;


-- =====================================================================
-- 1b. Are Owen's four identities splitting his history?
-- =====================================================================
-- Four identities on one name is not by itself a problem. lifetime_stats joins
-- sessions with status = 'ended', so an identity whose only seats sit in a game
-- that was abandoned rather than ended contributes nothing to the board — it is
-- a husk and can be left alone. One holding ended seats is a second Owen on the
-- leaderboard, splitting his totals.
--
-- This tells you which kind each of the four is. Tonight's insert doesn't depend
-- on the answer (block 3 pins the id either way) — his lifetime numbers do.
--
-- For any row that says merge, repoint the seats onto efbb9068 and drop the
-- husk. Same two steps as mergeIdentities in lib/services/game.ts:
--
--   update players set identity_id = 'efbb9068-c837-4063-b2bf-1282e380e883'
--    where identity_id in ('<ghost>', '<ghost>');
--   delete from players_identity where id in ('<ghost>', '<ghost>');
--
-- Safe against double-counting: sessions_played counts DISTINCT session_id, so a
-- night he played under two identities still counts once. Both seats' nets do
-- land, which is right — both really did buy in.
--
-- 4d5dbe5d holds no seats at all, so it is a husk whatever this returns:
--   delete from players_identity where id = '4d5dbe5d-ed33-493e-9a2a-1d5190d5b750';

select
  pi.id                                                          as identity_id,
  count(p.id)                                                    as seats_total,
  count(p.id) filter (where s.status = 'ended')                  as seats_in_ended,
  count(distinct p.session_id) filter (where s.status = 'ended') as ended_sessions,
  coalesce(sum(p.stack - p.total_buyin)
           filter (where s.status = 'ended'), 0)                 as net_on_board,
  max(s.created_at) filter (where s.status = 'ended')::date      as last_played,
  case
    when pi.id = 'efbb9068-c837-4063-b2bf-1282e380e883'
      then 'the keeper — leave it'
    when count(p.id) filter (where s.status = 'ended') = 0
      then 'husk — invisible to the leaderboard, leave it'
    else 'SHOWS AS ITS OWN ROW — merge into efbb9068'
  end                                                            as effect
from players_identity pi
left join players p on p.identity_id = pi.id
left join sessions s on s.id = p.session_id
where pi.display_name = 'Owen the great and wonderful'
group by pi.id
order by seats_in_ended desc;


-- =====================================================================
-- 2. Do the chips balance? — run before inserting
-- =====================================================================
-- These nets were checked before this file was written and they cancel, so
-- this should say 'ok'. Run it anyway: it's the same conservation rule that
-- query 0b in session-audit.sql will hold this night to forever after.

with night(name, buyin, net) as (values
  ('Owen the great and wonderful', 1000, -340),
  ('so did he embodies',           1000,   70),
  ('Chong',                        1000,  270)
)
select
  count(*)                    as players,
  sum(buyin)                  as total_bought_in,
  sum(net)                    as must_be_zero,
  min(buyin + net)            as smallest_final_stack,
  case
    when sum(net) <> 0        then 'STOP — nets do not cancel'
    when min(buyin + net) < 0 then 'STOP — a final stack is negative'
    when count(*) < 2         then 'STOP — a one-player night awards no placements'
    else 'ok'
  end                         as verdict
from night;


-- =====================================================================
-- 3. Insert the night — run once, when 1 and 2 both look right
-- =====================================================================
-- Seats are pinned by IDENTITY ID, not name, because block 1 came back with four
-- identities on "Owen the great and wonderful". Nothing enforces uniqueness on
-- display_name, so a name join here would have inserted one seat per match: six
-- seats instead of three, 6000 bought in against 4980 in stacks, and a session
-- 1020 chips short that query 0b would flag forever. Reproduced, not theorised.
--
-- Owen's seat goes to efbb9068 — the identity carrying 13 seats, against 1, 1 and
-- 0 on the others. If block 1b shows the two single-seat ones hold seats in ENDED
-- sessions, merge them into efbb9068 first; tonight's row is correct either way,
-- but his lifetime totals aren't until that's done.

begin;

with night(identity_id, buyin, net) as (values
  ('efbb9068-c837-4063-b2bf-1282e380e883'::uuid, 1000, -340),  -- Owen the great and wonderful
  ('8986ead2-b452-4e57-b6f9-d73f9f2cc96d'::uuid, 1000,   70),  -- so did he embodies
  ('f7707ac9-6de6-4bb2-aec9-c52c4f4252fd'::uuid, 1000,  270)   -- Chong
),
new_session as (
  insert into sessions (
    join_code, status, game_mode,
    small_blind, big_blind, starting_stack,
    blind_schedule, created_at, last_active_at
  )
  select
    'LIVECHIPS',                      -- off-pool marker: played on felt
    'ended',
    'cash',
    10,                               -- small blind
    20,                               -- big blind
    1000,                             -- what one seat cost
    '[]'::jsonb,
    timestamptz '2026-08-20 19:00-06',
    timestamptz '2026-08-20 23:00-06'
  returning id
)
insert into players (
  session_id, identity_id, display_name,
  stack, total_buyin,
  is_host, is_active, folded, seat_order
)
select
  ns.id,
  pi.id,
  pi.display_name,
  n.buyin + n.net,
  n.buyin,
  false, false, false,
  (row_number() over (order by pi.display_name))::int - 1
from night n
-- Inner join on purpose: a mistyped uuid drops that seat instead of inserting a
-- null-identity one, so the count comes up short and the books stop balancing.
-- Loud beats silent — see block 1.
join players_identity pi on pi.id = n.identity_id
cross join new_session ns;

-- Must say INSERT 0 3. Anything less means a uuid didn't match — `rollback;`.
commit;


-- =====================================================================
-- 4. Only if block 1 came back with an unmatched name
-- =====================================================================
-- Creates an identity with no device attached, so when that person next opens
-- the app they'll get a fresh one and their history will split. Better to have
-- them join a game once and use the identity that makes, unless they're never
-- going to play on the app at all.

-- insert into players_identity (display_name) values ('Name from block 1');


-- =====================================================================
-- 5. Check it landed, and how to undo it
-- =====================================================================
-- Expect three rows, nets -340 / +70 / +270, net_bb -17 / +3.5 / +13.5.

select display_name, net, net_bb, created_at
from session_results
where session_id = (select id from sessions
                    where join_code = 'LIVECHIPS'
                    order by created_at desc limit 1)
order by net desc;

-- Then sweep with query 0b in ../session-audit.sql — this night must NOT appear.
--
-- To undo: players cascades from sessions, so deleting the session takes the
-- seats with it. Confirm the id from the select above first.
--
-- delete from sessions where id = 'paste-the-id-here'::uuid;
