-- Chips — record a night played with REAL chips.
--
-- The leaderboard never reads the ledger: `lifetime_stats` and `session_results`
-- are built from `players` rows joined to `sessions` with status = 'ended', and
-- every figure on the board is some aggregate of `stack - total_buyin`. So a night
-- that was played with physical chips only needs a session row and one player row
-- per person, with a stack that produces the right net. No events, no hands, no
-- rebuys — those back the in-app table and the audit trail, not the standings.
--
-- What you lose by not playing in the app, and can't backfill: all-in counts (they
-- come from `events.all_in`, which only exists for actions the app witnessed) and
-- everything in player-stats.sql (VPIP, PFR, WTSD — all reconstructed from the
-- ledger). Those columns simply won't move for this night. Everything else — net,
-- the cumulative-net chart, times_first / times_last, sessions_played, the chaos
-- score — is computed from exactly what you're inserting here.
--
-- Paste these blocks into the Supabase SQL editor ONE AT A TIME, in order. Edit
-- the `night` list in 1, then paste the SAME list into 2 and 3 — the editor only
-- shows the last statement's result, so each block carries its own copy.


-- =====================================================================
-- 1. Who played, and what did they end up? — EDIT THIS, then run it
-- =====================================================================
-- One row per player: (name, what they bought in for, their net for the night).
-- `net` is what they walked away with minus what they put in — negative for a
-- loser. Buy-in is the cash total including rebuys, in the same chip units the
-- app uses at these stakes.
--
-- This block changes nothing. It resolves each name against `players_identity`
-- and reports what it found. Read every row before continuing:
--
--   identity_id null      → nobody by that name. A typo, or a first-time player.
--                           Fix the spelling, or run block 4 to create them.
--   two rows for one name  → duplicate identities (same person on two devices).
--                           Merge them first, or the night lands on one of them
--                           at random. See mergeIdentities in lib/services/game.ts.
--   name matched, but not  → the identity's stored display_name wins on the
--   the capitalisation       leaderboard; that's the one people will see.

with night(name, buyin, net) as (values
  -- ('Keogan',   200,  -150),
  -- ('Emily',    200,   340),
  -- ('Adam',     400,  -190)
  ('EDIT ME', 0, 0)
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
-- 2. Do the chips balance? — run this before inserting
-- =====================================================================
-- The invariant from session-audit.sql: every chip in a stack entered the game as
-- a buy-in, so across the table the nets must cancel to exactly zero. If they
-- don't, the table is short or over — somebody's count is wrong, or a buy-in went
-- unrecorded. Fix it here rather than inserting a session that query 0b will flag
-- forever after.
--
-- A stack that comes out negative (a net worse than the buy-in) is impossible for
-- the same reason: you can't lose chips you never bought.

with night(name, buyin, net) as (values
  ('EDIT ME', 0, 0)  -- ← same list as block 1
)
select
  count(*)                                        as players,
  sum(buyin)                                      as total_bought_in,
  sum(net)                                        as must_be_zero,
  min(buyin + net)                                as smallest_final_stack,
  case
    when sum(net) <> 0            then 'STOP — nets do not cancel'
    when min(buyin + net) < 0     then 'STOP — a final stack is negative'
    when count(*) < 2             then 'STOP — a one-player night awards no placements'
    else 'ok'
  end                                             as verdict
from night;


-- =====================================================================
-- 3. Insert the night — run once, when 1 and 2 both look right
-- =====================================================================
-- Set the date, the stakes and the buy-in on the session row:
--
--   created_at    orders the cumulative-net chart, so it must be the night that
--                 was played, not the night you got round to typing it in. Give
--                 it a real local time with an offset (-06 is MDT, -07 is MST).
--   big_blind     divides `net_bb`, which is what the chaos tab measures. Use the
--                 blind you actually played, or that night's volatility lands on
--                 the wrong scale next to the app-tracked ones.
--   join_code     deliberately off the 15-word invite pool — a code from the pool
--                 could surface this session to a phone typing that word in.
--   starting_stack  the standard buy-in for the night; cosmetic here, but it's
--                 what an audit reads as "what a seat cost".
--
-- Players are written inactive and hostless: nobody is sitting down, the night is
-- over, and an is_host flag on a session with no host_player_id is just noise.

begin;

with night(name, buyin, net) as (values
  ('EDIT ME', 0, 0)  -- ← same list as block 1
),
new_session as (
  insert into sessions (
    join_code, status, game_mode,
    small_blind, big_blind, starting_stack,
    blind_schedule, created_at, last_active_at
  )
  select
    'LIVECHIPS',                     -- off-pool marker: this night was played on felt
    'ended',
    'cash',                          -- or 'tournament'
    1,                               -- small blind
    2,                               -- big blind
    200,                             -- what one seat cost, before rebuys
    -- session_results divides net by the schedule's FIRST rung when there is one,
    -- and falls back to big_blind otherwise. A physical night has no escalation
    -- record, so leave the schedule empty and let the fallback do the work.
    '[]'::jsonb,
    timestamptz '2026-08-19 20:00-06',   -- ← when the night was PLAYED
    timestamptz '2026-08-19 23:30-06'    -- ← roughly when it broke up
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
  coalesce(pi.display_name, n.name),
  n.buyin + n.net,
  n.buyin,
  false, false, false,
  (row_number() over (order by n.name))::int - 1
from night n
cross join new_session ns
left join players_identity pi on lower(pi.display_name) = lower(n.name);

-- Nothing is committed until you run this. If the insert errored, run `rollback;`
-- instead and start again at block 1.
commit;

-- Then reload /chips/leaderboard, and sweep with query 0b in session-audit.sql —
-- the night you just added must not appear in it.


-- =====================================================================
-- 4. Only if block 1 found a genuinely new player
-- =====================================================================
-- Creates an identity with no device attached. When that person next opens the
-- app they'll get a fresh localStorage identity instead of this one, and their
-- history will split — so merge the two afterwards (mergeIdentities in
-- lib/services/game.ts), or just let them join a game once first and skip this.

insert into players_identity (display_name) values ('New Player Name');


-- =====================================================================
-- 5. Undo — removes a night inserted by block 3
-- =====================================================================
-- `players` cascades from `sessions`, so deleting the session takes its seats
-- with it. Check the select first; only then run the delete.

select s.id, s.created_at, s.join_code, count(p.id) as players, sum(p.total_buyin) as bought_in
from sessions s left join players p on p.session_id = s.id
where s.join_code = 'LIVECHIPS'
group by s.id
order by s.created_at desc;

-- delete from sessions where id = 'paste-the-id-here'::uuid;
