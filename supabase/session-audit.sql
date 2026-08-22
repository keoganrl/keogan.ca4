-- Chips — session audit: how to backtrack from a session_id.
--
-- Paste these into the Supabase SQL editor ONE BLOCK AT A TIME — the editor
-- only shows the result of the last statement, so running the whole file at
-- once throws away everything above it.
--
-- Every block runs as-is, against the MOST RECENT session. To point one at a
-- different session, replace its first line with that session's id:
--
--     with s as (select 'a1b2c3d4-....'::uuid as id)
--
-- Read them in order: 0 finds the right session, 1-3 tell you *whether* the
-- books balance, 4-8 tell you *where* they stopped balancing.
--
-- The one invariant that matters. Chips only ever live in three places:
-- a player's `stack`, the chips they've pushed into the current pot
-- (`hand_total_bet`, mirrored by `sessions.pot`), and nowhere else. Every chip
-- entered the game as a buy-in. So at all times:
--
--     sum(players.stack) + sessions.pot  ==  sum(players.total_buyin)
--
-- and during a hand, sum(players.hand_total_bet) == sessions.pot. When query 3
-- says those don't match, chips were minted or vanished, and queries 6-8 find
-- the hand it happened in. `net` on the cashout screen and the lifetime
-- leaderboard is always just stack - total_buyin, so a mismatch here IS the
-- wrong number people are looking at.


-- =====================================================================
-- 0. Which session is actually the current one?
-- =====================================================================
-- Run this FIRST, even if you're confident in the id. Join codes come from a
-- fixed 15-word pool, so they get REUSED across sessions — and findSessionByCode
-- resolves a code to "the most recent session that isn't ended". If an old
-- session on the same code was left un-ended, some phones can join *that* one
-- while the host plays in a new one. Two sessions, split records, both look
-- half-wrong. Two rows sharing one join code here is your answer.

select
  s.id,
  s.join_code,
  s.status,
  s.game_mode,
  s.starting_stack,
  s.small_blind || '/' || s.big_blind as blinds,
  s.pot,
  s.street,
  count(p.id)                                   as players,
  coalesce(sum(p.total_buyin), 0)               as total_bought_in,
  s.created_at,
  s.last_active_at
from sessions s
left join players p on p.session_id = s.id
where s.created_at >= current_date            -- today; widen if you need to
group by s.id
order by s.created_at desc;


-- =====================================================================
-- 0b. Every session that doesn't balance  ← run this to sweep history
-- =====================================================================
-- The same conservation check as query 3, across every session at once. This
-- is ground truth: it reads the stacks themselves rather than replaying the
-- ledger, so it catches drift whatever the cause. An empty result means every
-- session's books are square. Anything listed, take to query 5 / query 6.
--
-- Sessions still in progress legitimately show chips in the pot; that's why
-- pot is added in rather than ignored.

select
  s.id,
  s.created_at::date              as session_date,
  s.status,
  count(p.id)                     as players,
  sum(p.total_buyin)              as bought_in,
  sum(p.stack)                    as final_stacks,
  s.pot,
  sum(p.stack) + s.pot - sum(p.total_buyin) as drift
from sessions s
join players p on p.session_id = s.id
group by s.id
having sum(p.stack) + s.pot <> sum(p.total_buyin)
order by s.created_at;


-- =====================================================================
-- 1. The session header
-- =====================================================================
with s as (select id from sessions order by created_at desc limit 1)
select
  ses.*,
  (select display_name from players where session_id = ses.id and is_host limit 1) as host_name
from sessions ses
join s on s.id = ses.id;


-- =====================================================================
-- 2. The roster and everyone's net
-- =====================================================================
-- This is exactly what /chips/cashout renders. `net` is stack - total_buyin,
-- full stop — there is no other source for it.
--
-- Things to eyeball: a total_buyin that isn't starting_stack + (rebuys x
-- rebuy size); is_active = false on someone who played the entire session
-- (they left or were kicked and their row stopped being dealt in); hand_total_bet > 0 on a
-- session whose status is 'ended' (chips stranded on the felt — endSession is
-- supposed to refund those).

with s as (select id from sessions order by created_at desc limit 1)
select
  p.seat_order,
  p.display_name,
  p.stack,
  p.total_buyin,
  p.stack - p.total_buyin as net,
  p.is_host,
  p.is_active,
  p.folded,
  p.hand_total_bet,
  p.current_round_bet,
  p.identity_id,
  p.last_heartbeat_at
from players p
join s on s.id = p.session_id
order by p.seat_order;


-- =====================================================================
-- 3. Chip conservation check  ← the money query
-- =====================================================================
-- drift = 0 means the books balance and the numbers people are disputing are
-- real. drift > 0 means chips were minted; drift < 0 means chips vanished.

with s as (select id from sessions order by created_at desc limit 1),
t as (
  select
    (select pot from sessions where id = (select id from s))            as pot,
    coalesce(sum(p.stack), 0)                                           as stacks,
    coalesce(sum(p.total_buyin), 0)                                     as bought_in,
    coalesce(sum(p.hand_total_bet), 0)                                  as on_the_felt
  from players p
  join s on s.id = p.session_id
)
select
  stacks,
  pot,
  on_the_felt,
  bought_in,
  stacks + pot                as chips_in_play,
  stacks + pot - bought_in    as drift,              -- must be 0
  on_the_felt - pot           as pot_mismatch        -- must be 0 mid-hand
from t;


-- =====================================================================
-- 4. Buy-ins vs rebuys
-- =====================================================================
-- doRebuy writes three things: the stack, total_buyin, and a `rebuys` row,
-- plus a 'rebuy' event. A phone that dropped mid-write leaves them disagreeing,
-- and a rebuy counted in total_buyin but never added to the stack reads as a
-- pure loss on the leaderboard. All three columns should agree.

with s as (select id from sessions order by created_at desc limit 1)
select
  p.display_name,
  p.total_buyin,
  (select starting_stack from sessions where id = p.session_id)        as starting_stack,
  coalesce(r.rebuy_total, 0)                                           as rebuys_table_total,
  coalesce(e.event_total, 0)                                           as rebuy_events_total,
  p.total_buyin
    - (select starting_stack from sessions where id = p.session_id)
    - coalesce(r.rebuy_total, 0)                                       as unexplained_buyin
from players p
join s on s.id = p.session_id
left join (
  select player_id, sum(amount) as rebuy_total, count(*) as n
  from rebuys group by player_id
) r on r.player_id = p.id
left join (
  select player_id, sum(amount) as event_total
  from events where type = 'rebuy' group by player_id
) e on e.player_id = p.id
order by p.seat_order;


-- =====================================================================
-- 5. The full ledger, hand by hand
-- =====================================================================
-- The same list the in-app ledger shows, but complete and with the raw
-- amounts. AMOUNT CONVENTIONS DIFFER BY TYPE — this trips people up:
--   post_sb / post_bb  the blind
--   call               chips ADDED this action
--   bet / raise        the raise-TO total for that street (cumulative!)
--   win                that player's slice of the pot
--   rebuy              chips added
--   give               chips moved to target_player_id
--   adjust             host correction, signed
--   deal               hand boundary; street: a divider. Both amount-less.
-- So a "raise 400" line is a player at 400 total for the street, not 400 more.

with s as (select id from sessions order by created_at desc limit 1)
select
  count(*) filter (where e.type = 'deal') over (order by e.seq rows unbounded preceding) as hand,
  e.seq,
  e.street,
  p.display_name,
  e.type,
  e.amount,
  tp.display_name as target,
  e.created_at
from events e
join s on s.id = e.session_id
left join players p  on p.id  = e.player_id
left join players tp on tp.id = e.target_player_id
order by e.seq;


-- =====================================================================
-- 6. Per-hand reconciliation  ← finds WHICH hand broke
-- =====================================================================
-- Reconstructs chips into the pot from the ledger and compares against what
-- was paid out. Any hand where difference <> 0 is where the drift from query 3
-- entered. Run query 5 filtered to that hand to see it happen.
--
-- The reconstruction is per street, because bet/raise amounts are raise-to
-- totals: a player's commitment on a street is the larger of their last
-- raise-to and the sum of their blinds + calls. Reliable in practice, but two
-- legitimate cases show a difference and are NOT bugs: a hand voided by the
-- host (chips refunded with no 'win' event, shows negative), and a hand still
-- in progress at the bottom of the list.

with s as (select id from sessions order by created_at desc limit 1),
ev as (
  select
    e.*,
    count(*) filter (where e.type = 'deal') over (order by e.seq rows unbounded preceding) as hand_no
  from events e
  join s on s.id = e.session_id
),
by_street as (
  select
    hand_no,
    player_id,
    greatest(
      coalesce(max(amount) filter (where type in ('bet', 'raise')), 0),
      coalesce(sum(amount) filter (where type in ('post_sb', 'post_bb', 'call')), 0)
    ) as chips_in
  from ev
  where type in ('post_sb', 'post_bb', 'bet', 'raise', 'call')
    and player_id is not null
  group by hand_no, player_id, coalesce(street, 'preflop')
),
into_pot as (
  select hand_no, sum(chips_in) as chips_in from by_street group by hand_no
),
out_of_pot as (
  select hand_no, sum(amount) as chips_out from ev where type = 'win' group by hand_no
)
select
  hand_no as hand,
  coalesce(chips_in, 0)                        as chips_into_pot,
  coalesce(chips_out, 0)                       as chips_paid_out,
  coalesce(chips_out, 0) - coalesce(chips_in, 0) as difference   -- want 0
from into_pot
full join out_of_pot using (hand_no)
order by hand_no;


-- =====================================================================
-- 7. Manual corrections and chip transfers
-- =====================================================================
-- 'adjust' (host correction: moves a stack, deliberately does NOT touch
-- total_buyin) and 'give' (player-to-player transfer) are the two ways a net
-- changes without anyone winning a pot. If someone's number looks wrong by a
-- round amount, look here first.

with s as (select id from sessions order by created_at desc limit 1)
select
  e.seq,
  e.type,
  p.display_name   as player,
  e.amount,
  tp.display_name  as target,
  e.created_at
from events e
join s on s.id = e.session_id
left join players p  on p.id  = e.player_id
left join players tp on tp.id = e.target_player_id
where e.type in ('adjust', 'give', 'rebuy', 'join', 'leave', 'kick')
order by e.seq;


-- =====================================================================
-- 8. Pots recorded vs pots paid
-- =====================================================================
-- `hands` gets a row per completed hand with the pot total and winner; 'win'
-- events are the actual stack credits. Two rows that disagree, or a hand count
-- that doesn't match query 6, means an award ran twice or not at all.

with s as (select id from sessions order by created_at desc limit 1)
select
  (select count(*) from hands  where session_id = (select id from s))                        as hands_recorded,
  (select coalesce(sum(pot_total), 0) from hands where session_id = (select id from s))      as hands_pot_total,
  (select count(*) from events where session_id = (select id from s) and type = 'win')       as win_events,
  (select coalesce(sum(amount), 0) from events
     where session_id = (select id from s) and type = 'win')                                 as win_events_total,
  (select count(*) from events where session_id = (select id from s) and type = 'deal')      as hands_dealt;


-- =====================================================================
-- 8b. The known one: was the last hand refunded on top of being paid?
-- =====================================================================
-- Fixed 2026-08-14, but any session that ended BEFORE that fix carries it.
-- endSession used to hand back every player's `hand_total_bet`, which is only
-- cleared by the *next* deal — so ending the session right after the last
-- showdown (the normal way a session finishes) refunded that hand's commitment
-- on top of the pot the winners had already been awarded.
--
-- Signature: query 3's drift is positive and equals the total committed in the
-- final hand. To get that total, run query 5, take the events after the last
-- `deal`, and add up per player: blinds and calls accumulate, bet/raise
-- overwrite (they're raise-to totals for the street).
--
-- Repair, once you've confirmed drift matches: subtract each player's
-- final-hand commitment back off their stack. Buy-ins are untouched — they
-- were always right — so the nets come out correct on the cashout screen and
-- on the lifetime board.
--
--   update players set stack = stack - <their final-hand commitment>
--    where id = '<player id>';
--
-- Then re-run query 3 and confirm drift is 0.


-- =====================================================================
-- 9. Why the lifetime leaderboard might disagree with the session
-- =====================================================================
-- lifetime_stats only counts sessions with status = 'ended' — a session left
-- 'active' contributes nothing to anyone's totals — and it groups by
-- identity_id. A player who joined from a fresh browser/incognito minted a new
-- players_identity row, so their session lands on a second, near-empty entry
-- instead of their history. Rows below with a null identity_id, or an identity
-- whose only session is this one, are the ones to merge (mergeIdentities in
-- src/chips/lib/services/game.ts does that from the app).

with s as (select id from sessions order by created_at desc limit 1)
select
  p.display_name                                  as name_this_session,
  p.identity_id,
  pi.display_name                                 as identity_name,
  pi.created_at                                   as identity_created,
  (select status from sessions where id = p.session_id) as session_status,
  (select count(*) from players p2 where p2.identity_id = p.identity_id) as sessions_on_this_identity
from players p
join s on s.id = p.session_id
left join players_identity pi on pi.id = p.identity_id
order by p.seat_order;
