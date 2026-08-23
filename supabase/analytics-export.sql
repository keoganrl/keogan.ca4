-- Chips — analytics export: getting every player's history out of Supabase.
--
-- The leaderboard reads one view (`lifetime_stats`) with five numbers in it.
-- Everything else worth knowing about how people actually play is sitting in
-- the `events` ledger, unaggregated. These queries pull it out in shapes you
-- can drop straight into a spreadsheet or a notebook.
--
-- HOW TO GET A CSV OUT
--
--   Best for one table at a time — Supabase SQL editor:
--     paste a block, Run, then "Download CSV" under the results grid. No
--     install, and it's the only route that works from a phone. Results are
--     capped (the editor returns the first ~1000 rows), which the aggregate
--     queries here never hit but query 2 (raw ledger) eventually will.
--
--   Best for everything at once — psql against the connection string in
--   Supabase → Project Settings → Database (use the session pooler URI):
--     psql "$DB_URL" -c "\copy (<paste a query here>) to 'players.csv' csv header"
--   or dump the lot for offline work:
--     pg_dump "$DB_URL" --data-only --table='public.players' \
--       --table='public.sessions' --table='public.events' \
--       --table='public.hands' --table='public.rebuys' \
--       --table='public.players_identity' > chips.sql
--
--   Programmatic — the tables are already exposed to the Data API with open
--   anon policies (see chips-schema.sql), so
--   `supabase.from('events').select('*')` from a script works too. Note
--   PostgREST defaults to 1000 rows per request; page with .range().
--
-- Paste these into the SQL editor ONE BLOCK AT A TIME — it only shows the
-- result of the last statement in a run.
--
-- TWO THINGS THAT WILL SKEW EVERY NUMBER BELOW
--
--   1. Duplicate identities. Joining from a private tab mints a fresh
--      players_identity row, so one human can be several rows. Run the
--      leaderboard's "Merge duplicate players" first, or query 6 here to find
--      them. Sessions where identity_id is NULL entirely can't be attributed
--      to anyone and are dropped from every per-player rollup.
--   2. Unended sessions. `lifetime_stats` counts only status = 'ended', and
--      so does query 1. A session nobody tapped "end" on contributes nothing.
--      Query 6 lists them.


-- =====================================================================
-- 1. Player-session facts  ← start here; the one export to keep
-- =====================================================================
-- One row per player per session. This is the grain everything else pivots
-- from: drop it in a spreadsheet and you can get per-player totals, trends
-- over time, placement distributions, and stake-adjusted results without
-- writing any more SQL.
--
-- `net` is stack - total_buyin, the same number the cashout screen and the
-- lifetime board show. It is NOT comparable across sessions on its own — a
-- 1/2 cash game and a 5/10 tournament produce wildly different magnitudes —
-- so `net_bb` (net in big blinds) and `net_buyins` are the columns to
-- actually compare and average.

select
  s.created_at::date                                as session_date,
  s.id                                              as session_id,
  s.join_code,
  s.game_mode,
  s.small_blind || '/' || s.big_blind               as stakes,
  s.starting_stack,
  coalesce(pi.display_name, p.display_name)         as player,
  p.identity_id,
  p.display_name                                    as name_that_session,
  count(*) over (partition by p.session_id)         as table_size,
  rank() over (
    partition by p.session_id
    order by p.stack - p.total_buyin desc
  )                                                 as placement,
  p.is_host,
  p.is_active                                       as seated_at_end,
  p.total_buyin,
  p.stack                                           as final_stack,
  p.stack - p.total_buyin                           as net,
  -- Starting big blind, not s.big_blind: escalation rewrites big_blind in place, so at
  -- session end it holds the session's final rung. Same divisor as session_results.
  round((p.stack - p.total_buyin)::numeric
        / nullif(coalesce((s.blind_schedule -> 0 ->> 'big_blind')::numeric,
                          s.big_blind), 0), 1)      as net_bb,
  round((p.stack - p.total_buyin)::numeric / nullif(s.starting_stack, 0), 2) as net_buyins,
  coalesce(r.rebuy_count, 0)                        as rebuys,
  coalesce(r.rebuy_total, 0)                        as rebuy_chips,
  s.created_at
from players p
join sessions s on s.id = p.session_id
left join players_identity pi on pi.id = p.identity_id
left join (
  select player_id, count(*) as rebuy_count, sum(amount) as rebuy_total
  from rebuys group by player_id
) r on r.player_id = p.id
where s.status = 'ended'
order by s.created_at desc, placement;


-- =====================================================================
-- 2. The full ledger, every session, denormalized
-- =====================================================================
-- Every action anyone has ever taken, one row each, with the session and the
-- player's lifetime identity already joined on — no lookups needed
-- downstream. This is the raw material for anything queries 3-5 don't
-- already compute.
--
-- AMOUNT CONVENTIONS DIFFER BY TYPE. From session-audit.sql, repeated here
-- because it's the single easiest way to compute a wrong statistic:
--   post_sb / post_bb  the blind
--   call               chips ADDED by this action
--   bet / raise        the raise-TO total for that street (CUMULATIVE — a
--                      "raise 400" is a player at 400 total for the street,
--                      not 400 more)
--   win                that player's slice of the pot
--   rebuy              chips added
--   give               chips moved to `target`
--   adjust             host correction, signed
--   deal / street      hand boundary and street divider; no amount
--
-- Big export: this is every row in `events`. Use the psql \copy route above
-- rather than the SQL editor once you have more than a handful of sessions.

select
  s.created_at::date                                as session_date,
  e.session_id,
  count(*) filter (where e.type = 'deal')
    over (partition by e.session_id order by e.seq rows unbounded preceding) as hand_no,
  e.seq,
  coalesce(pi.display_name, p.display_name)         as player,
  p.identity_id,
  e.type,
  e.street,
  e.amount,
  coalesce(tpi.display_name, tp.display_name)       as target,
  e.created_at
from events e
join sessions s on s.id = e.session_id
left join players p   on p.id  = e.player_id
left join players_identity pi  on pi.id  = p.identity_id
left join players tp  on tp.id = e.target_player_id
left join players_identity tpi on tpi.id = tp.identity_id
order by s.created_at, e.session_id, e.seq;


-- =====================================================================
-- 3. Playing style per person  ← the one the leaderboard can't show
-- =====================================================================
-- Behavioural stats derived from the ledger: how often someone voluntarily
-- puts money in, how often they raise, how aggressive they are, how often
-- they fold. These are the numbers that say *why* a net is what it is.
--
-- NOTE: `player_stats` (supabase/player-stats.sql) computes vpip/pfr/af too, and it
-- is the CANONICAL definition — it is what the app and the generated profiles read.
-- The versions below are deliberately looser and are NOT kept in sync: this block
-- exists to hand you a spreadsheet, so it also covers seats with no linked identity
-- and adds `hands_at_table`, neither of which player_stats has. Expect small
-- disagreements between the two, and trust player_stats when they differ.
--
-- Poker's standard definitions, adapted to what this app records:
--   vpip_pct   % of hands with a voluntary preflop call/bet/raise. Blinds
--              don't count — they're forced. High = plays too many hands.
--   pfr_pct    % of hands with a preflop bet or raise. The gap between vpip
--              and pfr is passive limping.
--   af         aggression factor: (bets + raises) / calls, all streets. >2 is
--              aggressive, <1 is a calling station. NULL when they never
--              called.
--   fold_pct   % of hands folded at any point.
--   won_pct    % of hands where they collected chips.
--
-- THE DENOMINATOR IS AN APPROXIMATION and you should know how before quoting
-- these. The app doesn't record who was dealt into a hand, only who acted, so
-- `hands` counts hands where the player did *something*. A player who folds
-- is counted (folding is an event); a player the action never reached is not.
-- In practice that inflates vpip/pfr slightly against players in late
-- position. `hands_at_table` — every hand dealt while they were in the
-- session — is the conservative denominator; the truth is between the two.
-- Anyone with a low `hands` count has noise, not a read: filter them out.

with ev as (
  select
    e.*,
    count(*) filter (where e.type = 'deal')
      over (partition by e.session_id order by e.seq rows unbounded preceding) as hand_no
  from events e
  join sessions s on s.id = e.session_id and s.status = 'ended'
),
-- one row per player per hand, with what they did in it
per_hand as (
  select
    session_id,
    hand_no,
    player_id,
    count(*) filter (where type in ('call', 'bet', 'raise') and street = 'preflop') > 0 as vpip,
    count(*) filter (where type in ('bet', 'raise') and street = 'preflop')         > 0 as pfr,
    count(*) filter (where type = 'fold')                                           > 0 as folded,
    count(*) filter (where type = 'win')                                            > 0 as won,
    count(*) filter (where type in ('bet', 'raise'))                                    as aggressive_actions,
    count(*) filter (where type = 'call')                                               as calls,
    coalesce(sum(amount) filter (where type = 'win'), 0)                                as chips_won
  from ev
  where player_id is not null
    and hand_no > 0
    and type not in ('join', 'leave', 'kick', 'rebuy', 'adjust', 'give')
  group by session_id, hand_no, player_id
),
-- hands dealt in each session, for the conservative denominator
session_hands as (
  select e.session_id, count(*) as hands_dealt
  from events e
  join sessions s on s.id = e.session_id and s.status = 'ended'
  where e.type = 'deal'
  group by e.session_id
),
-- who a given key is, and which sessions they sat in
seats as (
  select
    coalesce(p.identity_id::text, 'unlinked:' || p.id::text) as key,
    coalesce(pi.display_name, p.display_name)                as player,
    p.identity_id,
    p.id                                                     as player_id,
    p.session_id
  from players p
  join sessions s on s.id = p.session_id and s.status = 'ended'
  left join players_identity pi on pi.id = p.identity_id
),
-- every hand dealt in a session they were seated for: the conservative denominator
at_table as (
  select st.key, sum(sh.hands_dealt) as hands_at_table
  from (select distinct key, session_id from seats) st
  join session_hands sh on sh.session_id = st.session_id
  group by st.key
),
by_identity as (
  select
    seats.key,
    min(seats.player)                                        as player,
    seats.identity_id,
    count(*)                                                 as hands,
    count(*) filter (where h.vpip)                           as vpip_hands,
    count(*) filter (where h.pfr)                            as pfr_hands,
    count(*) filter (where h.folded)                         as folded_hands,
    count(*) filter (where h.won)                            as won_hands,
    sum(h.aggressive_actions)                                as aggressive_actions,
    sum(h.calls)                                             as calls,
    sum(h.chips_won)                                         as chips_won,
    max(h.chips_won)                                         as biggest_pot
  from per_hand h
  join seats on seats.player_id = h.player_id
  group by seats.key, seats.identity_id
)
select
  b.player,
  b.identity_id,
  b.hands,
  a.hands_at_table,
  round(100.0 * b.vpip_hands   / nullif(b.hands, 0), 1) as vpip_pct,
  round(100.0 * b.pfr_hands    / nullif(b.hands, 0), 1) as pfr_pct,
  round(b.aggressive_actions::numeric / nullif(b.calls, 0), 2) as af,
  round(100.0 * b.folded_hands / nullif(b.hands, 0), 1) as fold_pct,
  round(100.0 * b.won_hands    / nullif(b.hands, 0), 1) as won_pct,
  b.chips_won,
  b.biggest_pot,
  b.aggressive_actions,
  b.calls
from by_identity b
left join at_table a on a.key = b.key
order by b.hands desc;


-- =====================================================================
-- 4. Per-session results table  ← for charting a trend line
-- =====================================================================
-- Query 1 collapsed to one row per player with a running total, so you can
-- plot everyone's bankroll over time without a spreadsheet formula. Ordered
-- oldest-first because that's what a line chart wants.

select
  coalesce(pi.display_name, p.display_name)               as player,
  p.identity_id,
  s.created_at::date                                      as session_date,
  p.stack - p.total_buyin                                 as net,
  -- Starting big blind, not s.big_blind — see query 1.
  round((p.stack - p.total_buyin)::numeric
        / nullif(coalesce((s.blind_schedule -> 0 ->> 'big_blind')::numeric,
                          s.big_blind), 0), 1)            as net_bb,
  sum(p.stack - p.total_buyin) over (
    partition by p.identity_id order by s.created_at
    rows unbounded preceding
  )                                                       as running_net,
  round(sum((p.stack - p.total_buyin)::numeric
            / nullif(coalesce((s.blind_schedule -> 0 ->> 'big_blind')::numeric,
                              s.big_blind), 0)) over (
    partition by p.identity_id order by s.created_at
    rows unbounded preceding
  ), 1)                                                   as running_net_bb,
  row_number() over (
    partition by p.identity_id order by s.created_at
  )                                                       as nth_session
from players p
join sessions s on s.id = p.session_id and s.status = 'ended'
left join players_identity pi on pi.id = p.identity_id
where p.identity_id is not null
order by player, s.created_at;


-- =====================================================================
-- 5. Head to head
-- =====================================================================
-- Every pair who has sat at the same table, how often, and how each did over
-- those shared sessions. Not "who beat whom in a hand" — the app doesn't record
-- hand-level opponents — but it does answer "does A only win when B is
-- there?", which is the argument people actually have.

with pairs as (
  select
    a.identity_id                                   as a_id,
    b.identity_id                                   as b_id,
    a.session_id,
    a.stack - a.total_buyin                         as a_net,
    b.stack - b.total_buyin                         as b_net
  from players a
  join players b
    on b.session_id = a.session_id
   and b.identity_id > a.identity_id          -- each pair once, no self-pairs
  join sessions s on s.id = a.session_id and s.status = 'ended'
  where a.identity_id is not null and b.identity_id is not null
)
select
  coalesce(pa.display_name, '?')  as player_a,
  coalesce(pb.display_name, '?')  as player_b,
  count(*)                        as sessions_together,
  sum(a_net)                      as a_net,
  sum(b_net)                      as b_net,
  count(*) filter (where a_net > b_net) as a_finished_ahead,
  count(*) filter (where b_net > a_net) as b_finished_ahead
from pairs
left join players_identity pa on pa.id = a_id
left join players_identity pb on pb.id = b_id
group by 1, 2
order by sessions_together desc, player_a;


-- =====================================================================
-- 6. Data-quality sweep  ← run BEFORE trusting anything above
-- =====================================================================
-- The three things that quietly corrupt a player-level rollup. Each block is
-- separate; run them one at a time.

-- 6a. Sessions that never got ended — invisible to the leaderboard and to
-- queries 1, 3, 4, 5. If a real session is in here, end it (or fix its status)
-- before exporting.
select
  s.id, s.created_at::date as session_date, s.join_code, s.status,
  count(p.id) as players, sum(p.total_buyin) as bought_in,
  max(p.last_heartbeat_at) as last_seen
from sessions s
left join players p on p.session_id = s.id
where s.status <> 'ended'
group by s.id
order by s.created_at desc;

-- 6b. Seats with no identity attached, and identities that only ever played
-- one session. Both are candidates for the leaderboard's merge tool — a real
-- regular fragmented across several rows will drag every average here off.
select
  coalesce(pi.display_name, p.display_name) as name,
  p.identity_id,
  count(*)                                  as sessions,
  min(s.created_at::date)                   as first_session_date,
  max(s.created_at::date)                   as last_session_date,
  case
    when p.identity_id is null then 'no identity — cannot be attributed'
    when count(*) = 1 then 'single session — possible duplicate'
    else 'ok'
  end                                       as flag
from players p
join sessions s on s.id = p.session_id
left join players_identity pi on pi.id = p.identity_id
group by p.identity_id, coalesce(pi.display_name, p.display_name)
having p.identity_id is null or count(*) = 1
order by name;

-- 6c. Sessions whose chips don't balance (same check as session-audit.sql query
-- 0b). Any session listed has a wrong `net` in it, so every rollup above
-- inherits that error. Take it to session-audit.sql before exporting.
select
  s.id, s.created_at::date as session_date, s.status,
  sum(p.total_buyin) as bought_in,
  sum(p.stack)       as final_stacks,
  s.pot,
  sum(p.stack) + s.pot - sum(p.total_buyin) as drift
from sessions s
join players p on p.session_id = s.id
group by s.id
having sum(p.stack) + s.pot <> sum(p.total_buyin)
order by s.created_at;
