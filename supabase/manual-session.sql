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
--   two rows for one name  → duplicate identities. Expect this: nothing enforces
--                           uniqueness on display_name, and a person picks up a
--                           new identity every time they open the app on another
--                           device or clear their storage. Decide which one is
--                           theirs NOW — block 3 wants the id, and it is the
--                           reason block 3 takes ids rather than names.
--                           Whether the extras also need merging is a separate
--                           question; block 1b answers it.
--   name matched, but not  → the identity's stored display_name wins on the
--   the capitalisation       leaderboard; that's the one people will see.
--
-- Don't skip this block: an unmatched name fails silently. The seat still
-- inserts, the books still balance and query 0b stays quiet, but a null
-- identity_id drops the row out of both lifetime_stats and session_results —
-- so that player's night vanishes from the board while still counting as a seat
-- for placements (session_extremes spans every seat on purpose) and so still
-- denying first or last to everyone else.

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
-- 1b. Are the duplicates actually splitting anyone's history?
-- =====================================================================
-- Only for names that came back more than once above. Swap in the name.
--
-- A duplicate identity is only a problem if it holds seats in ENDED sessions:
-- lifetime_stats joins sessions with status = 'ended', so an identity whose only
-- seats are in a game that was abandoned mid-hand contributes nothing to the
-- board and can be left alone. One that does hold ended seats is showing up as
-- its own leaderboard row, splitting that person in two.
--
-- To fix the ones that matter, repoint their seats onto the keeper and drop the
-- husks — the same two steps mergeIdentities takes in lib/services/game.ts:
--
--   update players set identity_id = '<keeper>'
--    where identity_id in ('<ghost>', '<ghost>');
--   delete from players_identity where id in ('<ghost>', '<ghost>');
--
-- Merging is safe against double-counting a night: sessions_played counts
-- DISTINCT session_id, so a night someone accidentally played under two
-- identities still counts once. Their nets from both seats do both land, which
-- is right — both seats really did buy in.

select
  pi.id                                                        as identity_id,
  count(p.id)                                                  as seats_total,
  count(p.id) filter (where s.status = 'ended')                as seats_in_ended,
  count(distinct p.session_id) filter (where s.status = 'ended') as ended_sessions,
  coalesce(sum(p.stack - p.total_buyin)
           filter (where s.status = 'ended'), 0)               as net_on_board,
  max(s.created_at) filter (where s.status = 'ended')::date     as last_played,
  -- The row with the most ended seats is normally the keeper; the rest are the
  -- candidates. This only classifies them — it doesn't know which you'll keep.
  case when count(p.id) filter (where s.status = 'ended') = 0
       then 'invisible to the leaderboard — leave it'
       else 'SHOWS AS ITS OWN ROW — merge unless this is the keeper' end as effect
from players_identity pi
left join players p on p.identity_id = pi.id
left join sessions s on s.id = p.session_id
where pi.display_name = 'Name that came back twice'
group by pi.id
order by seats_in_ended desc;


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
-- This block takes IDENTITY IDS, not names. Copy them out of block 1's
-- identity_id column.
--
-- Names are fine for looking people up and fatal for inserting them. The chips
-- app puts no uniqueness constraint on display_name — nothing stops one person
-- accumulating several identities, and in practice they do — so a name join
-- inserts one seat per matching identity. Four Owens on one name is four seats,
-- four buy-ins, and books that no longer balance. Pinning the id makes each seat
-- land exactly once, on the identity whose history you actually want it added to.
--
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
-- display_name is taken from the identity, so the board stays self-consistent.

begin;

with night(identity_id, buyin, net) as (values
  -- ('00000000-0000-0000-0000-000000000000'::uuid, 200, -150),
  -- ('00000000-0000-0000-0000-000000000000'::uuid, 200,  340),
  ('00000000-0000-0000-0000-000000000000'::uuid, 0, 0)
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
  pi.display_name,
  n.buyin + n.net,
  n.buyin,
  false, false, false,
  (row_number() over (order by pi.display_name))::int - 1
from night n
-- Inner join on purpose: a mistyped uuid drops the seat rather than inserting a
-- null-identity one, so the count below comes up short and the books stop
-- balancing. Loud beats silent — see the note in block 1.
join players_identity pi on pi.id = n.identity_id
cross join new_session ns;

-- CHECK THE ROW COUNT before committing: it must equal the number of players you
-- listed. Fewer means a uuid didn't match. `rollback;` instead if so.
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
