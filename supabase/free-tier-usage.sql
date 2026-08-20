-- Chips — free-tier usage: how close is this project to Supabase's free plan
-- limits, and how many more nights fit.
--
-- Paste these into the Supabase SQL editor ONE BLOCK AT A TIME — the editor
-- only shows the result of the last statement in a run.
--
-- THE ANSWER UP FRONT: disk is not the constraint. Realtime is.
--
-- A poker night is a handful of kilobytes of rows and tens of thousands of
-- websocket messages. The free plan gives 500 MB of database and 2 million
-- realtime messages a month, which means the database has room for thousands
-- of nights and the realtime quota has room for a few dozen. Block 4 is the
-- one to read.
--
-- WHAT SQL CAN AND CANNOT SEE
--
--   Measurable here (exact):   database size, row counts, growth per night.
--   NOT measurable here:       realtime messages, egress, API requests. None
--                              of it is stored in the database — it's metered
--                              by the platform. The ground truth is the
--                              dashboard: Project Settings → Usage, and
--                              Reports → Realtime. Blocks 4-6 ESTIMATE those
--                              from the game records so you can see the shape
--                              and the per-night cost; check them against the
--                              dashboard once and adjust the constants at the
--                              top of each block if they're off.
--
-- THE FREE PLAN LIMITS these blocks are measured against (verify on
-- supabase.com/pricing — they get revised, and the numbers are inlined in a
-- `limits` CTE at the top of each block so they're one edit to update):
--
--   Database size          500 MB      exceeded → project goes read-only
--   Egress (unified)       5 GB/month  DB + realtime + storage + auth combined
--   Realtime messages      2 M/month
--   Realtime connections   200 peak concurrent
--   Inactivity pause       7 days      (this is what api/keep-alive.js prevents)
--
-- Monthly active users doesn't apply: /chips has no accounts. Every phone hits
-- the Data API with the anon key and mints a players_identity row, which is an
-- ordinary table row, not an auth user. That limit can be ignored no matter how
-- many people play.
--
-- WHY REALTIME IS THE BINDING LIMIT, AND WHY IT'S QUADRATIC
--
-- Every phone at the table holds one channel subscribed to postgres_changes on
-- sessions, players and events (see subscribeToUpdates in
-- lib/stores/table.svelte.ts). A message is billed per DELIVERY, so one row
-- change at a table of N players is N messages, not one.
--
-- The dominant writer is not gameplay. It's the presence heartbeat: every open
-- client UPDATEs its own players row every 10 seconds (startHeartbeat, same
-- file), `players` is in the supabase_realtime publication, so each of those
-- writes fans out to all N phones:
--
--     heartbeat messages/minute = N clients × 6 writes/min × N recipients = 6N²
--
-- At six seats that's 216 messages a minute — about 52,000 over a four-hour
-- night — before anybody bets a chip. Actual play adds roughly 3N per ledger
-- event, which at the same table is under a tenth of the heartbeat traffic.
--
-- The consequence for who gets to use this: the quota is spent by
-- seats × hours, quadratically in seats, and NOT by how many people know about
-- the app. One regular group of six burns a small fraction of the month. A
-- ten-handed table costs about 2.8× a six-handed one for the same hours (10²/6²),
-- so the thing to watch if it spreads is big tables running long, not headcount.
--
-- If block 5 says the month is getting tight, the first fix is the heartbeat,
-- not the invite list — it's ~90% of the traffic and none of it needs to be
-- realtime. Either move last_heartbeat_at to its own table outside the
-- publication (the only reader is the stale-host check, which can poll it), or
-- raise the 10s interval — the saving is linear in the interval, so 30s cuts
-- heartbeat traffic to a third.


-- =====================================================================
-- 0. Headline: how full is the database?
-- =====================================================================
-- The whole project, guestbook included. A fresh Supabase project starts
-- around 8-10 MB of system catalogs before you add a single row, so a small
-- non-zero number here is the floor, not your data.

with limits as (select (500 * 1024 * 1024)::bigint as db_bytes)
select
  pg_size_pretty(pg_database_size(current_database()))          as db_size,
  pg_size_pretty(l.db_bytes)                                    as free_plan_limit,
  round(100.0 * pg_database_size(current_database()) / l.db_bytes, 2)
                                                                as pct_used,
  pg_size_pretty(l.db_bytes - pg_database_size(current_database()))
                                                                as headroom
from limits l;


-- =====================================================================
-- 1. Where the bytes are
-- =====================================================================
-- Every table in the project, biggest first, indexes counted separately.
-- `events` will be the top row and will stay the top row — it's the only
-- table that grows with how much people play rather than how often.

select
  c.relname                                      as table_name,
  pg_size_pretty(pg_total_relation_size(c.oid))  as total,
  pg_size_pretty(pg_relation_size(c.oid))        as rows_only,
  pg_size_pretty(pg_indexes_size(c.oid))         as indexes,
  c.reltuples::bigint                            as approx_rows
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
order by pg_total_relation_size(c.oid) desc;


-- =====================================================================
-- 2. What a night costs on disk, and how many more fit
-- =====================================================================
-- Divides the six chips tables by the number of sessions in them, then
-- projects the remaining space. `months_of_headroom` uses the last 90 days'
-- rate, so it reads null until there are sessions in that window.
--
-- Expect a number in the thousands. Disk is not what you need to ration.

with limits as (select (500 * 1024 * 1024)::bigint as db_bytes),
chips_size as (
  select coalesce(sum(pg_total_relation_size(c.oid)), 0) as bytes
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('sessions', 'players', 'events', 'hands', 'rebuys',
                      'players_identity')
),
counts as (
  select
    count(*)::numeric                                                as sessions,
    (count(*) filter (where created_at > now() - interval '90 days'))::numeric / 3
                                                                     as per_month
  from sessions
)
select
  c.sessions::int                                                    as sessions_recorded,
  round(c.per_month, 1)                                              as sessions_per_month_recent,
  pg_size_pretty(s.bytes)                                            as chips_tables_total,
  pg_size_pretty((s.bytes / nullif(c.sessions, 0))::bigint)          as per_session,
  floor((l.db_bytes - pg_database_size(current_database()))
        / nullif(s.bytes / nullif(c.sessions, 0), 0))::bigint        as more_sessions_that_fit,
  round((l.db_bytes - pg_database_size(current_database()))
        / nullif(s.bytes / nullif(c.sessions, 0), 0)
        / nullif(c.per_month, 0), 0)                                 as months_of_headroom
from limits l, chips_size s, counts c;


-- =====================================================================
-- 3. The shape of recent nights
-- =====================================================================
-- Seats, wall-clock length and ledger volume per session — the three inputs
-- the realtime estimate in block 4 multiplies together. Worth eyeballing
-- first: if `seats` or `minutes` looks wrong, so will everything downstream.
--
-- `minutes` spans the first and last ledger row, so a session left open with
-- nobody playing reads as short (correct — an idle table with no phones on it
-- costs nothing) but a session somebody left open ON A PHONE does not: the
-- heartbeat keeps writing. Those show up as long nights with few events, and
-- they are real quota spend, not a measurement artefact.

select
  s.created_at::date                                                 as night,
  s.join_code,
  s.status,
  (select count(*) from players p where p.session_id = s.id)         as seats,
  (select count(*) from events e where e.session_id = s.id)          as ledger_events,
  (select round(extract(epoch from (max(e.created_at) - min(e.created_at))) / 60)
     from events e where e.session_id = s.id)                        as minutes
from sessions s
order by s.created_at desc
limit 25;


-- =====================================================================
-- 4. Realtime messages per night  ← the limit that actually binds
-- =====================================================================
-- ESTIMATE, not a meter. The model, per the header:
--
--   heartbeat   = minutes × (60 / heartbeat_seconds) × seats × seats
--   gameplay    = ledger_events × writes_per_event × seats
--
-- `writes_per_event` is 3 because a typical action writes three published
-- rows — the player, the session, and the ledger line (a bet updates
-- players.stack, updates sessions.pot/current_actor_id, inserts the event).
--
-- Both terms assume every seat is connected for the whole night, which
-- overstates a table people drift in and out of. Treat the number as an
-- upper bound on a night of that shape.

with assumptions as (
  select 10::numeric   as heartbeat_seconds,   -- startHeartbeat interval
         3::numeric    as writes_per_event     -- published rows per ledger action
),
nights as (
  select
    s.id,
    s.created_at::date                                               as night,
    (select count(*) from players p where p.session_id = s.id)::numeric  as seats,
    (select count(*) from events e where e.session_id = s.id)::numeric   as ledger_events,
    coalesce((select extract(epoch from (max(e.created_at) - min(e.created_at))) / 60
                from events e where e.session_id = s.id), 0)::numeric    as minutes
  from sessions s
)
select
  n.night,
  n.seats::int,
  round(n.minutes)::int                                              as minutes,
  n.ledger_events::int,
  round(n.minutes * (60 / a.heartbeat_seconds) * n.seats * n.seats)::bigint
                                                                     as heartbeat_msgs,
  round(n.ledger_events * a.writes_per_event * n.seats)::bigint      as gameplay_msgs,
  round(n.minutes * (60 / a.heartbeat_seconds) * n.seats * n.seats
        + n.ledger_events * a.writes_per_event * n.seats)::bigint    as total_msgs,
  round(100 * n.minutes * (60 / a.heartbeat_seconds) * n.seats * n.seats
        / nullif(n.minutes * (60 / a.heartbeat_seconds) * n.seats * n.seats
                 + n.ledger_events * a.writes_per_event * n.seats, 0))
                                                                     as pct_heartbeat
from nights n, assumptions a
order by n.night desc
limit 25;


-- =====================================================================
-- 5. Month by month, against the 2 M message and 5 GB egress quotas
-- =====================================================================
-- Same model as block 4, rolled up per calendar month. The current month is
-- partial, so its percentages are a month-to-date reading, not a forecast.
--
-- `bytes_per_msg` is the shakiest constant in this file: a postgres_changes
-- payload carries the whole row plus its column metadata, so it's roughly a
-- kilobyte, but measure one in the browser network tab if egress ever looks
-- close. Egress also counts the ordinary API reads the app does on load, which
-- this doesn't model — the realtime stream dwarfs them during play, but a
-- number near the line here means look at the dashboard, not at this query.

with limits as (
  select 2000000::numeric                as msgs_per_month,
         (5::numeric * 1024 * 1024 * 1024) as egress_bytes_per_month
),
assumptions as (
  select 10::numeric   as heartbeat_seconds,
         3::numeric    as writes_per_event,
         1000::numeric as bytes_per_msg
),
nights as (
  select
    date_trunc('month', s.created_at)::date                          as month,
    (select count(*) from players p where p.session_id = s.id)::numeric  as seats,
    (select count(*) from events e where e.session_id = s.id)::numeric   as ledger_events,
    coalesce((select extract(epoch from (max(e.created_at) - min(e.created_at))) / 60
                from events e where e.session_id = s.id), 0)::numeric    as minutes
  from sessions s
),
per_month as (
  select
    n.month,
    count(*)                                                         as nights,
    sum(n.minutes * (60 / a.heartbeat_seconds) * n.seats * n.seats
        + n.ledger_events * a.writes_per_event * n.seats)            as msgs
  from nights n, assumptions a
  group by n.month
)
select
  m.month,
  m.nights,
  round(m.msgs)::bigint                                              as est_realtime_msgs,
  round(100 * m.msgs / l.msgs_per_month, 1)                          as pct_of_2m_msgs,
  pg_size_pretty(round(m.msgs * a.bytes_per_msg)::bigint)            as est_realtime_egress,
  round(100 * m.msgs * a.bytes_per_msg / l.egress_bytes_per_month, 1)
                                                                     as pct_of_5gb_egress
from per_month m, limits l, assumptions a
order by m.month desc;


-- =====================================================================
-- 6. How many nights a month fit, by table size
-- =====================================================================
-- The quadratic, made concrete. Nothing here reads your data — it's the model
-- from block 4 priced out for a night of `hours` at each table size, so it
-- answers the "can I let it spread?" question directly.
--
-- Change `hours` in the assumptions CTE to match how long your nights actually
-- run (block 3's `minutes` column is the honest input).

with limits as (
  select 2000000::numeric                  as msgs_per_month,
         (5::numeric * 1024 * 1024 * 1024) as egress_bytes_per_month
),
assumptions as (
  select 4::numeric    as hours,
         10::numeric   as heartbeat_seconds,
         3::numeric    as writes_per_event,
         1000::numeric as bytes_per_msg,
         60::numeric   as ledger_events_per_hour   -- hands × actions, per block 3
)
select
  seats,
  round(a.hours * 60 * (60 / a.heartbeat_seconds) * seats * seats
        + a.hours * a.ledger_events_per_hour * a.writes_per_event * seats)::bigint
                                                                     as msgs_per_night,
  pg_size_pretty(round((a.hours * 60 * (60 / a.heartbeat_seconds) * seats * seats
        + a.hours * a.ledger_events_per_hour * a.writes_per_event * seats)
        * a.bytes_per_msg)::bigint)                                  as egress_per_night,
  floor(l.msgs_per_month
        / (a.hours * 60 * (60 / a.heartbeat_seconds) * seats * seats
           + a.hours * a.ledger_events_per_hour * a.writes_per_event * seats))
                                                                     as nights_per_month_on_msgs,
  floor(l.egress_bytes_per_month
        / ((a.hours * 60 * (60 / a.heartbeat_seconds) * seats * seats
            + a.hours * a.ledger_events_per_hour * a.writes_per_event * seats)
           * a.bytes_per_msg))                                       as nights_per_month_on_egress
from generate_series(2, 10) as seats, limits l, assumptions a
order by seats;
