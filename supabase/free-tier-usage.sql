-- Chips — free-tier usage: how close is this project to Supabase's free plan,
-- and how much room is there to let more people play?
--
-- Paste these into the Supabase SQL editor ONE BLOCK AT A TIME — the editor
-- only shows the result of the last statement in a run.
--
-- THE ANSWER UP FRONT: disk is not the constraint. Realtime traffic is, and
-- for the way this app is actually used there is a lot of room in it.
--
-- The workload this is written against is a daily lunchtime game: five to
-- eight players, about an hour, most weekdays. Roughly twenty sessions a
-- month. That comes to something like 300-650k realtime messages and a few
-- hundred MB of egress a month — call it a fifth to a third of the realtime
-- allowance and around a tenth of egress. Real poker nights with real chips
-- don't touch this app at all and cost nothing.
--
-- Disk, at that rate, is measured in years: a session is on the order of a
-- hundred kilobytes of rows, twenty a month is a few MB, and the plan gives
-- 500 MB. Block 2 will say so in your own numbers.
--
-- WHICH LIMITS THESE BLOCKS MEASURE AGAINST
--
-- The free plan's summary card lists: unlimited API requests, 50,000 monthly
-- active users, 500 MB database, shared CPU / 500 MB RAM, 5 GB egress, 5 GB
-- cached egress, 1 GB file storage. Two of those matter here (database size,
-- egress) and the rest do not:
--
--   * Monthly active users never applies. /chips has no accounts — every
--     phone hits the Data API with the anon key and mints a players_identity
--     row, which is an ordinary table row, not an auth user. Invite whoever.
--   * Unlimited API requests means the request COUNT is free; the bytes those
--     requests return still land in the 5 GB egress bucket.
--   * Cached egress is a separate CDN bucket for static assets. Nothing on the
--     database or realtime path draws from it.
--   * File storage is unused — the app stores no files.
--
-- The realtime limits are NOT on that summary card. They live further down the
-- pricing page in the full plan-comparison table, under Realtime: 200 peak
-- concurrent connections, 2,000,000 messages a month, 256 KB max message size.
-- The message count is the one that binds, and blocks 4-6 price against it.
--
-- Max message size never will: a postgres_changes payload here is one players
-- or events row, on the order of a kilobyte against a 256 KB ceiling. Nothing
-- in this schema has a wide or unbounded column — blind_schedule is the widest
-- and it holds a handful of rungs.
--
-- Peak connections sounds like the limit a spreading game would hit first, but
-- it isn't: one phone is one connection, so 200 is 25-40 simultaneous tables of
-- this size (concurrent tables, not total players — the whole company can hold
-- the link as long as they aren't all sat down at once). Sustaining that many
-- overlapping tables would burn the monthly message budget in a couple of days.
-- Messages run out first unless the games are short and heavily simultaneous.
--
-- WHAT SQL CAN AND CANNOT SEE
--
--   Measurable here (exact):   database size, row counts, growth per session.
--   NOT measurable here:       realtime messages, egress, connections. None of
--                              it is stored in the database — it's metered by
--                              the platform. The ground truth is the dashboard:
--                              Project Settings → Usage, and Reports →
--                              Realtime. Blocks 4-6 ESTIMATE those from the
--                              game records so you can see the per-session
--                              cost and where it comes from; check them against
--                              the dashboard once and adjust the constants if
--                              they're off.
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
-- At six seats that's 216 messages a minute: ~13,000 of them spent in a
-- one-hour lunch game before anybody bets a chip. Play adds roughly 3N per
-- ledger event on top, which at that table size puts a session somewhere
-- around 18-26k messages depending on how busy the ledger is. Heartbeat is
-- the larger half on any table quieter than ~700 ledger rows an hour; block
-- 4's pct_heartbeat column gives the real split for your sessions.
--
-- What that means for who gets to use it: cost is seats × minutes, quadratic
-- in seats, and completely indifferent to how many people know the link. An
-- eight-handed hour costs 2.6× a five-handed one (8²/5²). Growth that adds
-- more games at the same size scales linearly and there is room for a few
-- times over; growth that makes the tables bigger is the expensive kind.
--
-- If block 5 ever looks tight, fix the heartbeat before restricting the invite
-- list — it's the majority of the traffic on a normal table, it's the part
-- that grows quadratically, and none of it needs to be realtime.
-- Either move last_heartbeat_at to its own table outside the publication (the
-- only reader is the stale-host check, which can poll it), or raise the 10s
-- interval; the saving is linear in the interval, so 30s cuts heartbeat traffic
-- to a third. Ordinary API reads need no such attention: load() already fetches
-- events incrementally (`gt('seq', sinceSeq)`), so a phone waking up pulls the
-- few rows it missed rather than the whole ledger.

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
-- 2. What a session costs on disk, and how many more fit
-- =====================================================================
-- Divides the six chips tables by the number of sessions in them, then
-- projects the remaining space. `months_of_headroom` uses the last 90 days'
-- rate, so it reads null until there are sessions in that window.
--
-- Expect a number in the thousands — at twenty sessions a month that is
-- years of headroom. Disk is not what you need to ration.

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
-- 3. The shape of recent sessions
-- =====================================================================
-- Seats, wall-clock length and ledger volume per session — the three inputs
-- the realtime estimate in block 4 multiplies together. Worth eyeballing
-- first: if `seats` or `minutes` looks wrong, so will everything downstream.
-- For a lunchtime game expect `minutes` around 60.
--
-- `minutes` spans the first and last ledger row, so a session left open with
-- nobody playing reads as short (correct — an idle table with no phones on it
-- costs nothing) but a session somebody left open ON A PHONE does not: the
-- heartbeat keeps writing. Those show up as long sessions with few events, and
-- they are real quota spend, not a measurement artefact. A lunch game whose tab
-- somebody left running all afternoon costs several times what it played.

select
  s.created_at::date                                                 as played_on,
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
-- 4. Realtime messages per session  ← the limit that actually binds
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
-- Both terms assume every seat is connected for the whole session, which
-- overstates a table people drift in and out of — normal at lunch, where
-- somebody always arrives late or leaves early. Treat the number as an upper
-- bound on a session of that shape.

with assumptions as (
  select 10::numeric   as heartbeat_seconds,   -- startHeartbeat interval
         3::numeric    as writes_per_event     -- published rows per ledger action
),
shaped as (
  select
    s.id,
    s.created_at::date                                               as played_on,
    (select count(*) from players p where p.session_id = s.id)::numeric  as seats,
    (select count(*) from events e where e.session_id = s.id)::numeric   as ledger_events,
    coalesce((select extract(epoch from (max(e.created_at) - min(e.created_at))) / 60
                from events e where e.session_id = s.id), 0)::numeric    as minutes
  from sessions s
)
select
  n.played_on,
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
from shaped n, assumptions a
order by n.played_on desc
limit 25;


-- =====================================================================
-- 5. Month by month, against the 2 M message and 5 GB egress quotas
-- =====================================================================
-- Same model as block 4, rolled up per calendar month — the reading to watch,
-- since a daily game's cost is a monthly rate rather than a per-session one.
-- The current month is partial, so its percentages are month-to-date, not a
-- forecast: divide by the fraction of the month elapsed to project.
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
shaped as (
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
    count(*)                                                         as sessions,
    sum(n.minutes * (60 / a.heartbeat_seconds) * n.seats * n.seats
        + n.ledger_events * a.writes_per_event * n.seats)            as msgs
  from shaped n, assumptions a
  group by n.month
)
select
  m.month,
  m.sessions,
  round(m.msgs)::bigint                                              as est_realtime_msgs,
  round(100 * m.msgs / l.msgs_per_month, 1)                          as pct_of_2m_msgs,
  pg_size_pretty(round(m.msgs * a.bytes_per_msg)::bigint)            as est_realtime_egress,
  round(100 * m.msgs * a.bytes_per_msg / l.egress_bytes_per_month, 1)
                                                                     as pct_of_5gb_egress
from per_month m, limits l, assumptions a
order by m.month desc;


-- =====================================================================
-- 6. How many sessions a month fit, by table size
-- =====================================================================
-- The quadratic, priced out. This is the "can I let it spread?" block: it
-- costs one session of `hours` at each table size, then divides the monthly
-- allowances by it.
--
-- Unlike blocks 4-5 this doesn't rate your history — it prices a hypothetical
-- table. The one thing it does read from your data is how busy a session's
-- ledger is: `ledger_events_per_hour` is measured from sessions long enough to
-- be representative, falling back to 300 on a database with nothing in it yet.
--
-- `hours` and `sessions_per_month` are the two dials. They default to the
-- lunchtime game — an hour, twenty times a month — so set them to whatever
-- you're actually pricing: a 1.5-hour sitting twice a weekday is
-- hours := 1.5, sessions_per_month := 44.

with limits as (
  select 2000000::numeric                  as msgs_per_month,
         (5::numeric * 1024 * 1024 * 1024) as egress_bytes_per_month
),
observed as (
  -- Ledger rows per hour, averaged over sessions with more than 15 minutes of
  -- play in them. Short and abandoned sessions are excluded: a session with two
  -- events a minute apart implies an absurd hourly rate and would drag the mean.
  select coalesce(round(avg(t.events / t.minutes * 60)), 300) as ledger_events_per_hour
  from (
    select
      (select count(*) from events e where e.session_id = s.id)::numeric as events,
      (select extract(epoch from (max(e.created_at) - min(e.created_at))) / 60
         from events e where e.session_id = s.id)::numeric               as minutes
    from sessions s
  ) t
  where t.minutes > 15
),
assumptions as (
  select 1::numeric    as hours,
         20::numeric   as sessions_per_month,
         10::numeric   as heartbeat_seconds,
         3::numeric    as writes_per_event,
         1000::numeric as bytes_per_msg
),
priced as (
  select
    seats,
    a.hours * 60 * (60 / a.heartbeat_seconds) * seats * seats
      + a.hours * o.ledger_events_per_hour * a.writes_per_event * seats as msgs,
    a.bytes_per_msg                                                     as bytes_per_msg,
    a.sessions_per_month                                                as per_month
  from generate_series(2, 10) as seats, assumptions a, observed o
)
select
  p.seats,
  round(p.msgs)::bigint                                                 as msgs_per_session,
  pg_size_pretty(round(p.msgs * p.bytes_per_msg)::bigint)               as egress_per_session,
  floor(l.msgs_per_month / p.msgs)                                      as max_sessions_on_msgs,
  floor(l.egress_bytes_per_month / (p.msgs * p.bytes_per_msg))          as max_sessions_on_egress,
  -- Peak concurrent connections is a cap on tables sat down AT ONCE, not per
  -- month — one phone is one connection. It only binds if more tables overlap
  -- than the message budget above allows in a whole month, which for a game
  -- that runs once a day it never will.
  floor(200 / seats)                                                    as concurrent_tables_on_connections,
  -- What the configured cadence actually spends.
  round(100 * p.per_month * p.msgs / l.msgs_per_month, 1)               as pct_of_msgs,
  round(100 * p.per_month * p.msgs * p.bytes_per_msg / l.egress_bytes_per_month, 1)
                                                                        as pct_of_egress
from priced p, limits l
order by p.seats;
