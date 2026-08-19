-- Chips — extended player stats: the poker-jargon numbers, reconstructed from the ledger.
--
-- Creates one view, `player_stats`, with a row per player and the standard hand-history
-- statistics on it: VPIP, PFR, aggression, c-bet, fold to c-bet, steal attempts, fold to
-- steal, WTSD, and a positional VPIP split.
--
-- Run this AFTER chips-schema.sql. Like the views in that file it is CREATE OR REPLACE,
-- so re-running it is both the install and the migration. It reads only existing tables
-- and writes nothing.
--
--   create ... ; grant select on player_stats to anon, authenticated, service_role;
--
-- ---------------------------------------------------------------------------
-- HOW POSITION IS RECOVERED, AND WHY IT IS TRUSTWORTHY
-- ---------------------------------------------------------------------------
-- The app never records who was on the button for a given hand — sessions.button_player_id
-- holds only the CURRENT button, overwritten every hand. Position is therefore
-- reconstructed, not read:
--
--   every hand posts blinds, and post_sb / post_bb name those two players. Combined with
--   players.seat_order that pins the entire ring: seats are walked forward from the small
--   blind, so SB = 0 seats after the SB, BB = 1, the button = n-1, the cutoff = n-2.
--
-- This is exact rather than approximate for the preflop street, which is the only street
-- position is used for. Preflop, action passes around the table in seat order, so every
-- player dealt in either posts a blind or gets a turn to act — there is no one for the
-- reconstruction to miss. (Players with a zero stack are dealt out entirely and correctly
-- absent.)
--
-- Two consequences worth knowing:
--   * At 3-handed there is no cutoff — the ring is SB, BB, button — and at 2-handed no
--     early position either. Short-handed nights therefore contribute nothing to the CO
--     columns rather than contributing something wrong.
--   * `n_players` counts the players who appear in that hand's ledger, which is the only
--     record of who was in it. The one way that drifts from who actually sat down is a
--     deleted `players` row: events.player_id is ON DELETE SET NULL, so those actions lose
--     their owner, the hand's ring shrinks, and the positions for that hand shift. Leaving
--     and being kicked both only flip is_active, so in normal use nothing is ever deleted
--     and this stays theoretical.
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
--   cbet_flop_pct      as the preflop raiser, how often they bet the flop when they saw one
--   fold_to_cbet_pct   facing a flop c-bet, how often they folded
--   steal_pct          from CO/BTN/SB with everyone before them folded, how often they raised
--   fold_to_steal_pct  in a blind facing a steal attempt, how often they folded
--   wtsd_pct           having seen a flop, how often they reached showdown
--   vpip_early/late/blinds_pct   the same VPIP split by where they were sitting
--
-- Every percentage has its denominator beside it (`*_opps`). A number with a denominator
-- of 3 is an anecdote, not a read — filter on the opportunity counts before quoting
-- anything, and see `reliability` for a blunt version of that rule.

create or replace view player_stats as

-- Hand-numbered events for ended sessions only, matching lifetime_stats' scope.
with ev as (
  select
    e.*,
    count(*) filter (where e.type = 'deal')
      over (partition by e.session_id order by e.seq rows unbounded preceding) as hand_no
  from events e
  join sessions s on s.id = e.session_id and s.status = 'ended'
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
ring as (
  select
    d.session_id,
    d.hand_no,
    d.player_id,
    b.sb_id,
    b.bb_id,
    n.n_players,
    case
      when d.player_id = b.sb_id then 'SB'
      when d.player_id = b.bb_id then 'BB'
      when off.seats_after_sb = n.n_players - 1 then 'BTN'
      when off.seats_after_sb = n.n_players - 2 then 'CO'
      else 'EARLY'
    end as position
  from dealt d
  join blinds b on b.session_id = d.session_id and b.hand_no = d.hand_no
  join players p on p.id = d.player_id
  join players sbp on sbp.id = b.sb_id
  cross join lateral (
    select count(*) as n_players
    from dealt d2
    where d2.session_id = d.session_id and d2.hand_no = d.hand_no
  ) n
  cross join lateral (
    select ((p.seat_order - sbp.seat_order) + n.n_players) % n.n_players as seats_after_sb
  ) off
  where b.sb_id is not null and b.bb_id is not null
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
reached as (
  select
    session_id,
    hand_no,
    bool_or(street = 'flop')     as saw_flop,
    bool_or(street = 'showdown') as saw_showdown
  from ev
  where type = 'street'
  group by session_id, hand_no
),

-- The flop continuation bet: the first bet on the flop, if the preflop aggressor made it.
cbet as (
  select
    f.session_id,
    f.hand_no,
    f.player_id as cbetter_id,
    f.seq       as cbet_seq
  from (
    select
      e.session_id, e.hand_no, e.player_id, e.seq,
      row_number() over (partition by e.session_id, e.hand_no order by e.seq) as rn
    from ev e
    where e.street = 'flop' and e.type in ('bet', 'raise')
  ) f
  join preflop pf on pf.session_id = f.session_id and pf.hand_no = f.hand_no
  where f.rn = 1 and f.player_id = pf.aggressor_id
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
    (pf.aggressor_id = r.player_id)                                         as was_aggressor,
    (cb.cbetter_id = r.player_id)                                           as made_cbet,

    -- faced a c-bet: someone else c-bet and they still had an action to take after it
    (cb.cbet_seq is not null
      and cb.cbetter_id <> r.player_id
      and bool_or(e.seq > cb.cbet_seq and e.street = 'flop'))               as faced_cbet,
    (cb.cbet_seq is not null
      and cb.cbetter_id <> r.player_id
      and bool_or(e.seq > cb.cbet_seq and e.street = 'flop' and e.type = 'fold')) as folded_to_cbet,

    -- steal: had the chance to open from CO/BTN/SB with the pot still unopened
    (r.position in ('CO', 'BTN', 'SB')
      and (pf.first_voluntary_seq is null
           or pf.first_voluntary_seq >= coalesce(
                min(e.seq) filter (where e.street = 'preflop' and e.type in ('call','raise','fold')),
                pf.first_voluntary_seq)))                                   as steal_opportunity,
    (st.stealer_id = r.player_id)                                           as attempted_steal,

    -- defending a blind against someone else's steal
    (st.steal_seq is not null
      and st.stealer_id <> r.player_id
      and r.position in ('SB', 'BB')
      and bool_or(e.seq > st.steal_seq and e.street = 'preflop'))           as faced_steal,
    (st.steal_seq is not null
      and st.stealer_id <> r.player_id
      and r.position in ('SB', 'BB')
      and bool_or(e.seq > st.steal_seq and e.street = 'preflop' and e.type = 'fold')) as folded_to_steal

  from ring r
  join ev e
    on e.session_id = r.session_id and e.hand_no = r.hand_no and e.player_id = r.player_id
  left join reached rc on rc.session_id = r.session_id and rc.hand_no = r.hand_no
  left join preflop pf on pf.session_id = r.session_id and pf.hand_no = r.hand_no
  left join cbet cb    on cb.session_id = r.session_id and cb.hand_no = r.hand_no
  left join steal st   on st.session_id = r.session_id and st.hand_no = r.hand_no
  where e.type not in ('rebuy', 'adjust', 'give', 'join', 'leave', 'kick')
  group by
    r.session_id, r.hand_no, r.player_id, r.position,
    rc.saw_flop, rc.saw_showdown, pf.aggressor_id, pf.first_voluntary_seq,
    cb.cbetter_id, cb.cbet_seq, st.stealer_id, st.steal_seq
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

    count(*) filter (where h.was_aggressor and h.saw_flop)                  as cbet_opps,
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

grant select on player_stats to anon, authenticated, service_role;
