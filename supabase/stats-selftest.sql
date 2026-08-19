-- Chips — stats self-test: a synthetic ledger with hand-computed expected outputs.
--
-- Verifies that `player_stats` (player-stats.sql) and `session_results`
-- (chips-schema.sql) reconstruct the right numbers from the ledger. Four players
-- play four hands written in the exact shapes the app's logEvent calls produce,
-- covering the cases that have historically been easy to get wrong:
--
--   * a button steal, a blind defence, and a fold to a steal
--   * a limped pot where a later raise must NOT count as a steal
--   * a donk bet into the preflop aggressor (kills the c-bet opportunity)
--   * a preflop all-in run-out, which logs only street='showdown' (no flop marker)
--   * a small blind all-in from the post, who never gets a turn at all
--   * placement on degenerate tables: a solo session and a session nobody played,
--     neither of which is a contest and neither of which may award a first or a last
--
-- Everything runs inside one transaction and ROLLS BACK, so it is safe to run
-- against a live database: nothing is left behind. Run it with psql
-- (see analytics-export.sql for the connection string route):
--
--   psql "$DB_URL" -f supabase/stats-selftest.sql
--
-- The one result grid at the end lists mismatches between the views and the
-- expected values. ZERO ROWS = PASS. (In the Supabase SQL editor, run the file
-- as-is; the editor only shows the final statement's result, so if it reports
-- the rollback instead of the grid, delete the trailing `rollback;`, run, read
-- the grid, then run `rollback;` by itself.)

begin;

insert into players_identity (id, display_name) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'selftest A'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'selftest B'),
  ('cccccccc-0000-0000-0000-00000000000c', 'selftest C'),
  ('dddddddd-0000-0000-0000-00000000000d', 'selftest D'),
  ('eeeeeeee-0000-0000-0000-00000000000e', 'selftest E'),
  ('ffffffff-0000-0000-0000-00000000000f', 'selftest F'),
  ('99999999-0000-0000-0000-000000000009', 'selftest G');

-- s1: flat 1/2 game (no schedule). s2: escalated night that started at 25/50 and
-- ended at 100/200 — net_bb must divide by the 50, not the 200.
insert into sessions (id, join_code, status, small_blind, big_blind, starting_stack) values
  ('11111111-0000-0000-0000-000000000001', 'selftest-one', 'ended', 1, 2, 1000);
insert into sessions (id, join_code, status, small_blind, big_blind, starting_stack, blind_schedule) values
  ('22222222-0000-0000-0000-000000000002', 'selftest-two', 'ended', 100, 200, 1000,
   '[{"level":1,"small_blind":25,"big_blind":50,"duration_minutes":0},
     {"level":2,"small_blind":50,"big_blind":100,"duration_minutes":0},
     {"level":3,"small_blind":100,"big_blind":200,"duration_minutes":0}]'::jsonb);

insert into players (id, session_id, identity_id, display_name, stack, total_buyin, seat_order) values
  ('aaaaaaaa-1111-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'A', 1210, 1000, 0),
  ('bbbbbbbb-1111-0000-0000-00000000000b', '11111111-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-00000000000b', 'B',  900, 1000, 1),
  ('cccccccc-1111-0000-0000-00000000000c', '11111111-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-00000000000c', 'C',  950, 1000, 2),
  ('dddddddd-1111-0000-0000-00000000000d', '11111111-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000d', 'D',  940, 1000, 3),
  ('eeeeeeee-2222-0000-0000-00000000000e', '22222222-0000-0000-0000-000000000002', 'eeeeeeee-0000-0000-0000-00000000000e', 'E', 1500, 1000, 0);

-- Placement fixtures for lifetime_stats. No events: these exist only to exercise
-- which sessions are allowed to award a first or a last, and F/G play no hands so
-- they never appear in player_stats.
--   s3  one player alone  -> not a contest, awards nothing
--   s4  two players, both flat at zero (nobody played) -> awards nothing
--   s5  a real contest    -> F first, G last
insert into sessions (id, join_code, status, small_blind, big_blind, starting_stack) values
  ('33333333-0000-0000-0000-000000000003', 'selftest-solo', 'ended', 1, 2, 200),
  ('44444444-0000-0000-0000-000000000004', 'selftest-flat', 'ended', 1, 2, 200),
  ('55555555-0000-0000-0000-000000000005', 'selftest-real', 'ended', 1, 2, 200);

insert into players (session_id, identity_id, display_name, stack, total_buyin, seat_order) values
  ('33333333-0000-0000-0000-000000000003', 'ffffffff-0000-0000-0000-00000000000f', 'selftest F', 300, 200, 0),
  ('44444444-0000-0000-0000-000000000004', 'ffffffff-0000-0000-0000-00000000000f', 'selftest F', 200, 200, 0),
  ('44444444-0000-0000-0000-000000000004', '99999999-0000-0000-0000-000000000009', 'selftest G', 200, 200, 1),
  ('55555555-0000-0000-0000-000000000005', 'ffffffff-0000-0000-0000-00000000000f', 'selftest F', 300, 200, 0),
  ('55555555-0000-0000-0000-000000000005', '99999999-0000-0000-0000-000000000009', 'selftest G', 100, 200, 1);

-- The ledger, in exact chronological order. Amount conventions match logEvent:
-- blinds = blind size; bet/raise = raise-to total; call = chips added; win = pot slice.
with e(ord, player, type, amount, street) as (values
  -- Hand 1: button A -> SB B, BB C, CO D, BTN A.
  ( 1, null, 'deal',    null::int, null),
  ( 2, 'B',  'post_sb', 1,    null),
  ( 3, 'C',  'post_bb', 2,    null),
  ( 4, 'D',  'fold',    null, 'preflop'),   -- CO folds first in: steal opp, declined
  ( 5, 'A',  'raise',   6,    'preflop'),   -- BTN open = steal attempt; A is aggressor
  ( 6, 'B',  'fold',    null, 'preflop'),   -- SB folds to the steal
  ( 7, 'C',  'call',    4,    'preflop'),   -- BB defends
  ( 8, null, 'street',  null, 'flop'),
  ( 9, 'C',  'check',   null, 'flop'),
  (10, 'A',  'bet',     4,    'flop'),      -- c-bet
  (11, 'C',  'call',    4,    'flop'),
  (12, null, 'street',  null, 'turn'),
  (13, 'C',  'check',   null, 'turn'),
  (14, 'A',  'check',   null, 'turn'),
  (15, null, 'street',  null, 'river'),
  (16, 'C',  'check',   null, 'river'),
  (17, 'A',  'check',   null, 'river'),
  (18, null, 'street',  null, 'showdown'),
  (19, 'A',  'win',     21,   null),

  -- Hand 2: button B -> SB C, BB D, CO A, BTN B. Limped pot, donk-bet flop.
  (20, null, 'deal',    null, null),
  (21, 'C',  'post_sb', 1,    null),
  (22, 'D',  'post_bb', 2,    null),
  (23, 'A',  'call',    2,    'preflop'),   -- CO limp: steal opp, declined by limping
  (24, 'B',  'raise',   8,    'preflop'),   -- raise over a limp: NOT a steal; B aggressor
  (25, 'C',  'fold',    null, 'preflop'),
  (26, 'D',  'call',    6,    'preflop'),
  (27, 'A',  'call',    6,    'preflop'),
  (28, null, 'street',  null, 'flop'),
  (29, 'D',  'bet',     5,    'flop'),      -- donk bet into the aggressor
  (30, 'A',  'fold',    null, 'flop'),
  (31, 'B',  'call',    5,    'flop'),      -- aggressor never had a c-bet chance
  (32, null, 'street',  null, 'turn'),
  (33, 'D',  'bet',     10,   'turn'),
  (34, 'B',  'call',    10,   'turn'),
  (35, null, 'street',  null, 'river'),
  (36, 'D',  'check',   null, 'river'),
  (37, 'B',  'check',   null, 'river'),
  (38, null, 'street',  null, 'showdown'),
  (39, 'D',  'win',     55,   null),

  -- Hand 3: button C -> SB D, BB A, CO B, BTN C. Preflop all-in run-out:
  -- advanceStreet jumps straight to showdown, so no flop/turn/river markers exist.
  (40, null, 'deal',    null, null),
  (41, 'D',  'post_sb', 1,    null),
  (42, 'A',  'post_bb', 2,    null),
  (43, 'B',  'raise',   30,   'preflop'),   -- CO open = steal attempt
  (44, 'C',  'fold',    null, 'preflop'),
  (45, 'D',  'raise',   100,  'preflop'),   -- SB 3-bet all-in; D is now the aggressor
  (46, 'A',  'fold',    null, 'preflop'),   -- BB folds to the steal
  (47, 'B',  'call',    70,   'preflop'),
  (48, null, 'street',  null, 'showdown'),
  (49, 'D',  'win',     202,  null),

  -- Hand 4: button B -> SB C (all-in posting the blind, never acts), BB D, CO A, BTN B.
  (50, null, 'deal',    null, null),
  (51, 'C',  'post_sb', 1,    null),
  (52, 'D',  'post_bb', 2,    null),
  (53, 'A',  'fold',    null, 'preflop'),   -- CO folds first in
  (54, 'B',  'raise',   6,    'preflop'),   -- BTN steal (A's fold is not voluntary)
  (55, 'D',  'fold',    null, 'preflop'),   -- BB folds; C is all-in, run-out
  (56, null, 'street',  null, 'showdown'),
  (57, 'B',  'win',     9,    null)
)
insert into events (session_id, player_id, type, amount, street)
select
  '11111111-0000-0000-0000-000000000001',
  case e.player
    when 'A' then 'aaaaaaaa-1111-0000-0000-00000000000a'::uuid
    when 'B' then 'bbbbbbbb-1111-0000-0000-00000000000b'::uuid
    when 'C' then 'cccccccc-1111-0000-0000-00000000000c'::uuid
    when 'D' then 'dddddddd-1111-0000-0000-00000000000d'::uuid
  end,
  e.type, e.amount, e.street
from e
order by e.ord;

-- ---------------------------------------------------------------- assertions
-- Expected values computed by hand from the hands above. Zero rows = pass.

with exp(display_name, hands,
         vpip_pct, pfr_pct, vpip_pfr_gap, af,
         cbet_flop_pct, cbet_opps, fold_to_cbet_pct, faced_cbet_opps,
         steal_pct, steal_opps, fold_to_steal_pct, faced_steal_opps,
         wtsd_pct, saw_flop_hands,
         vpip_early_pct, early_hands, vpip_late_pct, late_hands,
         vpip_blinds_pct, blind_hands, chips_won, biggest_pot) as (
  values
  -- A: h1 BTN steal + c-bet, won at showdown; h2 CO limp, folded to the flop donk;
  --    h3 BB folded to the steal; h4 CO folded first in.
  ('selftest A', 4::bigint, 50.0::numeric, 25.0::numeric, 25.0::numeric, 1.00::numeric,
   100.0::numeric, 1::bigint, null::numeric, 0::bigint,
   33.3::numeric, 3::bigint, 100.0::numeric, 1::bigint,
   50.0::numeric, 2::bigint,
   null::numeric, 0::bigint, 66.7::numeric, 3::bigint,
   0.0::numeric, 1::bigint, 21::bigint, 21::bigint),
  -- B: h1 SB folded to the steal; h2 raised over a limp (no steal), faced the donk
  --    (no c-bet opp), showdown; h3 CO steal, called the 3-bet all-in, showdown;
  --    h4 BTN steal, run-out showdown against the all-in SB.
  ('selftest B', 4, 75.0, 75.0, 0.0, 1.00,
   null, 0, null, 0,
   100.0, 2, 100.0, 1,
   100.0, 3,
   null, 0, 100.0, 3,
   0.0, 1, 9, 9),
  -- C: h1 BB defended and called the c-bet down to showdown; h2 SB folded after a
  --    limp (no steal opp); h3 BTN folded after a raise (no steal opp); h4 SB all-in
  --    from the post, never acted (no steal opp, but reaches the run-out showdown).
  ('selftest C', 4, 25.0, 0.0, 25.0, 0.00,
   null, 0, 0.0, 1,
   null, 0, 0.0, 1,
   100.0, 2,
   null, 0, 0.0, 1,
   33.3, 3, 0, 0),
  -- D: h1 CO folded first in (steal opp declined); h2 BB defended, donk-bet flop and
  --    turn, won at showdown; h3 SB 3-bet all-in over the steal, won; h4 BB folded
  --    to the steal.
  ('selftest D', 4, 50.0, 25.0, 25.0, 3.00,
   null, 0, null, 0,
   0.0, 1, 50.0, 2,
   100.0, 2,
   null, 0, 0.0, 1,
   66.7, 3, 257, 202)
),
act as (
  select display_name, hands,
         vpip_pct, pfr_pct, vpip_pfr_gap, af,
         cbet_flop_pct, cbet_opps, fold_to_cbet_pct, faced_cbet_opps,
         steal_pct, steal_opps, fold_to_steal_pct, faced_steal_opps,
         wtsd_pct, saw_flop_hands,
         vpip_early_pct, early_hands, vpip_late_pct, late_hands,
         vpip_blinds_pct, blind_hands, chips_won, biggest_pot
  from player_stats
  where display_name like 'selftest _'
),
-- session_results: net_bb must use the night's STARTING big blind.
-- s1 has no schedule (starting = final = 2): A's net 210 -> 105.00.
-- s2 escalated 50 -> 200: E's net 500 -> 10.00 by the starting blind.
sr_exp(display_name, net, net_bb) as (values
  ('selftest A', 210, 105.00::numeric),
  ('selftest E', 500, 10.00::numeric)
),
sr_act as (
  select display_name, net, net_bb from session_results
  where display_name in ('selftest A', 'selftest E')
),
-- lifetime_stats placement. F plays three sessions but only ONE of them is a contest:
-- the solo table and the flat table must award nothing to anybody.
lt_exp(display_name, sessions_played, times_first, times_last) as (values
  ('selftest F', 3::bigint, 1::bigint, 0::bigint),
  ('selftest G', 2::bigint, 0::bigint, 1::bigint)
),
lt_act as (
  select display_name, sessions_played, times_first, times_last
  from lifetime_stats
  where display_name in ('selftest F', 'selftest G')
)
select mismatch, details from (
  select 'player_stats: expected, view disagrees' as mismatch, to_jsonb(x) as details
    from (table exp except table act) x
  union all
  select 'player_stats: view produced, not expected', to_jsonb(y)
    from (table act except table exp) y
  union all
  select 'session_results: expected, view disagrees', to_jsonb(v)
    from (table sr_exp except table sr_act) v
  union all
  select 'session_results: view produced, not expected', to_jsonb(w)
    from (table sr_act except table sr_exp) w
  union all
  select 'lifetime_stats: expected, view disagrees', to_jsonb(m)
    from (table lt_exp except table lt_act) m
  union all
  select 'lifetime_stats: view produced, not expected', to_jsonb(n)
    from (table lt_act except table lt_exp) n
) t
order by mismatch;

rollback;
