-- Chips — extended player stats: the poker-jargon numbers, reconstructed from the ledger.
--
-- Gives you `player_stats`, a row per player carrying the standard hand-history
-- statistics: VPIP, PFR, aggression, c-bet, fold to c-bet, steal attempts, fold to
-- steal, WTSD, and a positional VPIP split.
--
-- It comes in two pieces. `player_stats_source` is the query that derives them, and
-- `player_stats` is a MATERIALIZED snapshot of it — reading the query directly times
-- out, for reasons documented at the bottom of this file. Read `player_stats`; call
-- `refresh_player_stats()` whenever a session ends.
--
-- Run this AFTER chips-schema.sql. Re-running it is both the install and the
-- migration: the view is CREATE OR REPLACE and the snapshot is IF NOT EXISTS, so a
-- second run leaves existing data alone. It reads only existing tables.
--
-- ---------------------------------------------------------------------------
-- HOW POSITION IS RECOVERED, AND WHY IT IS TRUSTWORTHY
-- ---------------------------------------------------------------------------
-- The app never records who was on the button for a given hand — sessions.button_player_id
-- holds only the CURRENT button, overwritten every hand. Position is therefore
-- reconstructed, not read:
--
--   every hand posts blinds, and post_sb / post_bb name those two players. Combined with
--   players.seat_order that pins the entire ring: the hand's participants are ranked by
--   seat and walked forward from the small blind, so SB = 0 seats after the SB, BB = 1,
--   the button = n-1, the cutoff = n-2. The walk uses each player's RANK among that
--   hand's participants, never raw seat_order differences — seat numbers are not
--   contiguous once someone busts (dealt out) or leaves (their row keeps its seat), and
--   raw differences would smear the button/cutoff labels across the wrong seats.
--
-- This is exact rather than approximate for the preflop street, which is the only street
-- position is used for. Preflop, action passes around the table in seat order, so every
-- player dealt in either posts a blind or gets a turn to act — there is no one for the
-- reconstruction to miss. (Players with a zero stack are dealt out entirely and correctly
-- absent.)
--
-- Three consequences worth knowing:
--   * At 3-handed there is no cutoff — the ring is SB, BB, button — and at 2-handed no
--     early position either. Short-handed sessions therefore contribute nothing to the CO
--     columns rather than contributing something wrong.
--   * `n_players` counts the players who appear in that hand's ledger, which is the only
--     record of who was in it. The one way that drifts from who actually sat down is a
--     deleted `players` row: events.player_id is ON DELETE SET NULL, so those actions lose
--     their owner, the hand's ring shrinks, and the positions for that hand shift. Leaving
--     and being kicked both only flip is_active, so in normal use nothing is ever deleted
--     and this stays theoretical.
--   * seat_order is read as it stands NOW. The host's mid-session "reorder seats" rewrites
--     those values in place, so hands played before a reorder are walked against the new
--     arrangement: SB and BB stay right (they come from events), but BTN/CO/EARLY labels
--     for those earlier hands can shift. Reordering is rare and the blinds columns are
--     immune, so this is accepted rather than modeled.
--
-- ---------------------------------------------------------------------------
-- WHAT THE COLUMNS MEAN
-- ---------------------------------------------------------------------------
--   hands              hands where the player did something (acted or posted a blind)
--   vpip_pct           % of hands with a voluntary preflop call or raise. Posting a blind
--                      is forced and does not count; checking a free BB does not either.
--   pfr_pct            % of hands with a preflop raise. vpip minus pfr is passive limping.
--   af                 aggression factor, (bets + raises) / calls across all streets.
--                      >2 aggressive, <1 a calling station. NULL if they never called.
--   cbet_flop_pct      as the preflop raiser, how often they bet the flop when they could
--   fold_to_cbet_pct   facing a flop c-bet, how often their immediate response was a fold
--   steal_pct          from CO/BTN/SB with everyone before them folded, how often they raised
--   fold_to_steal_pct  in a blind facing a steal, how often their immediate response was a fold
--   wtsd_pct           having seen a flop, how often they reached showdown
--   vpip_early/late/blinds_pct   the same VPIP split by where they were sitting
--
-- Every percentage has its denominator beside it (`*_opps`). A number with a denominator
-- of 3 is an anecdote, not a read — filter on the opportunity counts before quoting
-- anything, and see `reliability` for a blunt version of that rule.

create or replace view player_stats_source as

-- Hand-numbered events for ended SERIES sessions only.
--
-- The series_id predicate is doing two jobs, and the second is the load-bearing one.
--
-- First, it is the requirement: a one-off session must not feed anybody's generated
-- profile or coaching, and this view is where those numbers come from.
--
-- Second, it keeps a garbage collection from looking like a change of behaviour.
-- Single sessions are deleted after five days (api/keep-alive.js). player_stats is a
-- MATERIALIZED snapshot of this query, so if one-off hands were counted here they
-- would sit in everyone's figures until the purge removed the rows, and the next
-- refresh_player_stats() would silently subtract them. api/profile.js decides whom to
-- rewrite by comparing current figures against the ones each profile was written
-- from, so that subtraction would read as drift and buy a full-table rewrite — paid
-- for, and caused by nothing but a scheduled delete. Excluding them here means a
-- purge cannot move these numbers at all.
--
-- Added 2026-08 alongside sessions.series_id. Because this is a materialized view,
-- the change only lands on the next refresh: run `select refresh_player_stats();`
-- after applying this file.
with ev as (
  select
    e.*,
    count(*) filter (where e.type = 'deal')
      over (partition by e.session_id order by e.seq rows unbounded preceding) as hand_no
  from events e
  join sessions s on s.id = e.session_id
    and s.status = 'ended'
    and s.series_id is not null
),

-- Who posted the blinds in each hand. array_agg()[1] rather than min()/max(): there is no
-- aggregate over uuid, and there is exactly one of each per hand anyway.
blinds as (
  select
    session_id,
    hand_no,
    (array_agg(player_id) filter (where type = 'post_sb'))[1] as sb_id,
    (array_agg(player_id) filter (where type = 'post_bb'))[1] as bb_id
  from ev
  where type in ('post_sb', 'post_bb')
  group by session_id, hand_no
),

-- Everyone who appears in a hand. Chip movements that aren't hand actions (rebuys, host
-- corrections, transfers, seat changes) are excluded so they can't invent a participant.
dealt as (
  select distinct session_id, hand_no, player_id
  from ev
  where player_id is not null
    and hand_no > 0
    and type not in ('rebuy', 'adjust', 'give', 'join', 'leave', 'kick')
),

-- The ring, with each seat's position label for that hand.
--
-- seats-after-the-SB is computed from each player's RANK among the hand's participants
-- ordered by seat, rotated so the small blind is rank zero. It must NOT be computed from
-- raw seat_order differences: seat numbers stop being contiguous the moment a player
-- busts (dealt out, absent from the hand) or leaves (their row keeps its seat), and with
-- a gap in the ring the raw arithmetic assigns BTN/CO to the wrong seats — it can even
-- label two players BTN in the same hand. The rank walk is gap-proof.
ring as (
  select
    session_id,
    hand_no,
    player_id,
    sb_id,
    bb_id,
    n_players,
    case
      when player_id = sb_id then 'SB'
      when player_id = bb_id then 'BB'
      when (seat_rank - sb_rank + n_players) % n_players = n_players - 1 then 'BTN'
      when (seat_rank - sb_rank + n_players) % n_players = n_players - 2 then 'CO'
      else 'EARLY'
    end as position
  from (
    select
      rb.*,
      -- the SB always appears in its own hand (it posted a blind), so this is never null
      max(rb.seat_rank) filter (where rb.player_id = rb.sb_id)
        over (partition by rb.session_id, rb.hand_no) as sb_rank
    from (
      select
        d.session_id,
        d.hand_no,
        d.player_id,
        b.sb_id,
        b.bb_id,
        count(*) over (partition by d.session_id, d.hand_no) as n_players,
        row_number() over (
          partition by d.session_id, d.hand_no
          order by p.seat_order, d.player_id
        ) as seat_rank
      from dealt d
      join blinds b on b.session_id = d.session_id and b.hand_no = d.hand_no
      join players p on p.id = d.player_id
      where b.sb_id is not null and b.bb_id is not null
    ) rb
  ) ranked
),

-- Per hand: the last preflop raiser (the preflop aggressor), and the seq of the first
-- voluntary preflop action, which is what makes a later raise NOT a steal.
preflop as (
  select
    session_id,
    hand_no,
    (array_agg(player_id order by seq desc) filter (where type = 'raise'))[1] as aggressor_id,
    min(seq) filter (where type in ('call', 'raise'))                        as first_voluntary_seq
  from ev
  where street = 'preflop' and hand_no > 0
  group by session_id, hand_no
),

-- Hands that reached each street, and whether they reached showdown.
--
-- A showdown implies a flop even when no 'flop' row exists: an all-in run-out skips the
-- per-street markers and logs only street = 'showdown' (advanceStreet jumps straight
-- there), but the board still gets dealt. Without that implication every preflop all-in
-- disappears from the WTSD denominator while still counting in its numerator — the
-- hands MOST likely to reach showdown go missing, and the stat can exceed 100%.
reached as (
  select
    session_id,
    hand_no,
    bool_or(street in ('flop', 'showdown')) as saw_flop,
    bool_or(street = 'showdown')            as saw_showdown
  from ev
  where type = 'street'
  group by session_id, hand_no
),

-- The first bet on the flop, whoever made it. Needed on its own (not just as the c-bet
-- below) because a bet by anyone ELSE before the aggressor's first flop action is what
-- takes the aggressor's c-bet opportunity away.
flop_bet as (
  select
    f.session_id,
    f.hand_no,
    f.player_id,
    f.seq
  from (
    select
      e.session_id, e.hand_no, e.player_id, e.seq,
      row_number() over (partition by e.session_id, e.hand_no order by e.seq) as rn
    from ev e
    where e.street = 'flop' and e.type in ('bet', 'raise')
  ) f
  where f.rn = 1
),

-- The flop continuation bet: the first bet on the flop, if the preflop aggressor made it.
cbet as (
  select
    fb.session_id,
    fb.hand_no,
    fb.player_id as cbetter_id,
    fb.seq       as cbet_seq
  from flop_bet fb
  join preflop pf on pf.session_id = fb.session_id and pf.hand_no = fb.hand_no
  where fb.player_id = pf.aggressor_id
),

-- A steal attempt: a raise from CO/BTN/SB that is the first voluntary action of the hand.
steal as (
  select
    e.session_id,
    e.hand_no,
    e.player_id as stealer_id,
    e.seq       as steal_seq
  from ev e
  join preflop pf on pf.session_id = e.session_id and pf.hand_no = e.hand_no
  join ring r
    on r.session_id = e.session_id and r.hand_no = e.hand_no and r.player_id = e.player_id
  where e.street = 'preflop'
    and e.type = 'raise'
    and e.seq = pf.first_voluntary_seq
    and r.position in ('CO', 'BTN', 'SB')
),

-- One row per player per hand, with every per-hand fact the aggregates need.
per_hand as (
  select
    r.session_id,
    r.hand_no,
    r.player_id,
    r.position,

    -- voluntary money in preflop: a call or raise, never a posted blind
    bool_or(e.street = 'preflop' and e.type in ('call', 'raise'))          as vpip,
    bool_or(e.street = 'preflop' and e.type = 'raise')                     as pfr,
    bool_or(e.type = 'fold')                                               as folded,
    count(*) filter (where e.type in ('bet', 'raise'))                     as aggressive,
    count(*) filter (where e.type = 'call')                                as calls,
    coalesce(sum(e.amount) filter (where e.type = 'win'), 0)               as chips_won,

    -- saw a flop: the hand got there and they had not already folded preflop
    (rc.saw_flop and not bool_or(e.street = 'preflop' and e.type = 'fold')) as saw_flop,
    -- reached showdown: the hand got there and they never folded at all
    (rc.saw_showdown and not bool_or(e.type = 'fold'))                      as showdown,

    -- c-bet: they were the preflop aggressor and the first flop bet was theirs
    (cb.cbetter_id = r.player_id)                                           as made_cbet,

    -- c-bet OPPORTUNITY: the preflop aggressor could actually have made the first
    -- bet of the flop. Two ways to not have the chance, both excluded here:
    --   * they never took a flop action of their own — an all-in aggressor reaches
    --     the run-out's flop without ever being able to bet it, and has no flop rows;
    --   * somebody bet the flop before their first action (a donk bet) — facing a
    --     bet they can only raise, and a raise is not a c-bet.
    (pf.aggressor_id = r.player_id
      and bool_or(e.street = 'flop')
      and (fb.seq is null
           or min(e.seq) filter (where e.street = 'flop') <= fb.seq))       as cbet_opp,

    -- faced a c-bet: someone else c-bet and they still had an action to take after it.
    -- Folding to it means their FIRST flop action after the c-bet was the fold —
    -- calling the c-bet and then folding to a later raise on the same street is a fold
    -- to the raise, not to the c-bet, and must not count here.
    (cb.cbet_seq is not null
      and cb.cbetter_id <> r.player_id
      and bool_or(e.seq > cb.cbet_seq and e.street = 'flop'))               as faced_cbet,
    (cb.cbet_seq is not null
      and cb.cbetter_id <> r.player_id
      and (array_agg(e.type order by e.seq)
             filter (where e.seq > cb.cbet_seq and e.street = 'flop'))[1] = 'fold') as folded_to_cbet,

    -- steal: had the chance to open from CO/BTN/SB with the pot still unopened. The
    -- player must have taken a preflop action of their own — a blind who was all-in
    -- from the post never gets a turn, and a chance they never had is not an
    -- opportunity (same reasoning as the c-bet denominator above).
    (r.position in ('CO', 'BTN', 'SB')
      and min(e.seq) filter (where e.street = 'preflop'
                               and e.type in ('call','raise','fold')) is not null
      and (pf.first_voluntary_seq is null
           or pf.first_voluntary_seq >=
              min(e.seq) filter (where e.street = 'preflop'
                                   and e.type in ('call','raise','fold'))))  as steal_opportunity,
    (st.stealer_id = r.player_id)                                           as attempted_steal,

    -- defending a blind against someone else's steal. Folding to it means their FIRST
    -- preflop action after the steal was the fold — a blind that 3-bets the steal and
    -- later folds to a 4-bet fought back and lost, which is not folding to the steal.
    (st.steal_seq is not null
      and st.stealer_id <> r.player_id
      and r.position in ('SB', 'BB')
      and bool_or(e.seq > st.steal_seq and e.street = 'preflop'))           as faced_steal,
    (st.steal_seq is not null
      and st.stealer_id <> r.player_id
      and r.position in ('SB', 'BB')
      and (array_agg(e.type order by e.seq)
             filter (where e.seq > st.steal_seq and e.street = 'preflop'))[1] = 'fold') as folded_to_steal

  from ring r
  join ev e
    on e.session_id = r.session_id and e.hand_no = r.hand_no and e.player_id = r.player_id
  left join reached rc  on rc.session_id = r.session_id and rc.hand_no = r.hand_no
  left join preflop pf  on pf.session_id = r.session_id and pf.hand_no = r.hand_no
  left join flop_bet fb on fb.session_id = r.session_id and fb.hand_no = r.hand_no
  left join cbet cb     on cb.session_id = r.session_id and cb.hand_no = r.hand_no
  left join steal st    on st.session_id = r.session_id and st.hand_no = r.hand_no
  where e.type not in ('rebuy', 'adjust', 'give', 'join', 'leave', 'kick')
  group by
    r.session_id, r.hand_no, r.player_id, r.position,
    rc.saw_flop, rc.saw_showdown, pf.aggressor_id, pf.first_voluntary_seq,
    fb.seq, cb.cbetter_id, cb.cbet_seq, st.stealer_id, st.steal_seq
),

-- Collapse seats onto lifetime identities. Seats with no identity are dropped: they
-- cannot be attributed to a person, so counting them would inflate a stranger's row.
by_identity as (
  select
    p.identity_id,
    min(coalesce(pi.display_name, p.display_name))                          as display_name,
    count(*)                                                                as hands,
    count(*) filter (where h.vpip)                                          as vpip_hands,
    count(*) filter (where h.pfr)                                           as pfr_hands,
    sum(h.aggressive)                                                       as aggressive_actions,
    sum(h.calls)                                                            as calls,

    -- cbet_opp, not "was aggressor and saw the flop": an all-in aggressor reaches the
    -- run-out's flop without a chance to bet it, and an aggressor facing a donk bet
    -- can only raise — neither ever had the chance the percentage claims to measure.
    count(*) filter (where h.cbet_opp)                                      as cbet_opps,
    count(*) filter (where h.made_cbet)                                     as cbets,
    count(*) filter (where h.faced_cbet)                                    as faced_cbet_opps,
    count(*) filter (where h.folded_to_cbet)                                as folds_to_cbet,

    count(*) filter (where h.steal_opportunity)                             as steal_opps,
    count(*) filter (where h.attempted_steal)                               as steals,
    count(*) filter (where h.faced_steal)                                   as faced_steal_opps,
    count(*) filter (where h.folded_to_steal)                               as folds_to_steal,

    count(*) filter (where h.saw_flop)                                      as saw_flop_hands,
    count(*) filter (where h.showdown)                                      as showdowns,

    count(*) filter (where h.position = 'EARLY')                            as early_hands,
    count(*) filter (where h.position = 'EARLY' and h.vpip)                 as early_vpip,
    count(*) filter (where h.position in ('CO', 'BTN'))                     as late_hands,
    count(*) filter (where h.position in ('CO', 'BTN') and h.vpip)          as late_vpip,
    count(*) filter (where h.position in ('SB', 'BB'))                      as blind_hands,
    count(*) filter (where h.position in ('SB', 'BB') and h.vpip)           as blind_vpip,

    sum(h.chips_won)                                                        as chips_won,
    max(h.chips_won)                                                        as biggest_pot
  from per_hand h
  join players p on p.id = h.player_id
  left join players_identity pi on pi.id = p.identity_id
  where p.identity_id is not null
  group by p.identity_id
)

select
  identity_id,
  display_name,
  hands,
  -- A blunt guard against reading a percentage off five hands.
  case
    when hands >= 200 then 'ok'
    when hands >= 50  then 'thin'
    else 'anecdote'
  end                                                              as reliability,

  round(100.0 * vpip_hands / nullif(hands, 0), 1)                  as vpip_pct,
  round(100.0 * pfr_hands  / nullif(hands, 0), 1)                  as pfr_pct,
  round(100.0 * (vpip_hands - pfr_hands) / nullif(hands, 0), 1)    as vpip_pfr_gap,
  round(aggressive_actions::numeric / nullif(calls, 0), 2)         as af,

  round(100.0 * cbets / nullif(cbet_opps, 0), 1)                   as cbet_flop_pct,
  cbet_opps,
  round(100.0 * folds_to_cbet / nullif(faced_cbet_opps, 0), 1)     as fold_to_cbet_pct,
  faced_cbet_opps,

  round(100.0 * steals / nullif(steal_opps, 0), 1)                 as steal_pct,
  steal_opps,
  round(100.0 * folds_to_steal / nullif(faced_steal_opps, 0), 1)   as fold_to_steal_pct,
  faced_steal_opps,

  round(100.0 * showdowns / nullif(saw_flop_hands, 0), 1)          as wtsd_pct,
  saw_flop_hands,

  round(100.0 * early_vpip / nullif(early_hands, 0), 1)            as vpip_early_pct,
  early_hands,
  round(100.0 * late_vpip  / nullif(late_hands, 0), 1)             as vpip_late_pct,
  late_hands,
  round(100.0 * blind_vpip / nullif(blind_hands, 0), 1)            as vpip_blinds_pct,
  blind_hands,

  chips_won,
  biggest_pot
from by_identity
order by hands desc;

-- NOT granted to anon/authenticated: read directly this view takes minutes (see the
-- note at the foot of this file) and the Data API kills it at three seconds, so
-- exposing it only offers a way to tie up a connection. Everything reads the
-- materialised player_stats below instead.
grant select on player_stats_source to service_role;

-- ---------------------------------------------------------------------------
-- WHY player_stats IS A SNAPSHOT AND NOT THE VIEW ABOVE
-- ---------------------------------------------------------------------------
-- Read directly, the view above cannot be planned. Every stage of it is fast in
-- isolation — the whole chain runs in ~130ms when each CTE is materialised as a
-- table — but the planner estimates the `ev` stage at ~13 rows when it returns
-- thousands, so every stage downstream is estimated at one row and it picks
-- nested loops the whole way up. Measured on a 12k-event ledger: over 120
-- SECONDS as written, 60ms with enable_nestloop off. Supabase's Data API gives a
-- statement 3 seconds, so every query against it failed with 57014 — including
-- `limit 1` and single-identity filters, neither of which lets the planner skip
-- any of the work.
--
-- Adding statistics does not help: ANALYZE on every base table changed nothing.
-- The estimate is a structural property of the CTE chain, not of stale stats.
--
-- So the numbers are computed once and stored. That suits how they change: a
-- player's figures only move when a session ends, which is exactly when the
-- refresh runs, so a snapshot is never meaningfully behind. Reads drop from a
-- timeout to a sub-millisecond scan of a dozen rows, and the cost stops growing
-- with the length of your history.
--
-- Keeping the NAME player_stats on the snapshot means every reader — the app,
-- the prompt lab, anything you query by hand — is unchanged and simply fast.
-- Earlier installs shipped player_stats as a plain view. IF NOT EXISTS would happily
-- skip past one and leave the un-plannable version serving the app, so the old view
-- is dropped explicitly first — and only when it really is a view, so re-running this
-- against the snapshot does not throw and does not discard it.
do $$
begin
  if exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relname = 'player_stats' and n.nspname = 'public' and c.relkind = 'v'
  ) then
    execute 'drop view player_stats';
  end if;
end
$$;

-- The first build needs the same planner override the refresh function carries;
-- without it this statement is the two-minute one and the migration appears hung.
set enable_nestloop = off;
create materialized view if not exists player_stats as select * from player_stats_source;
reset enable_nestloop;

-- REFRESH CONCURRENTLY requires a unique index, and is worth having: a plain
-- refresh takes an exclusive lock, so anyone with the leaderboard open at the
-- moment a session ends would block on it.
create unique index if not exists player_stats_identity_idx on player_stats (identity_id);

grant select on player_stats to anon, authenticated, service_role;

-- The planner override lives on the function rather than in the caller's session,
-- so a refresh cannot be run without it and take two minutes.
create or replace function refresh_player_stats() returns void
language plpgsql
security definer
set search_path = public
set enable_nestloop = 'off'
as $$
begin
  refresh materialized view concurrently player_stats;
end;
$$;

grant execute on function refresh_player_stats() to anon, authenticated, service_role;
