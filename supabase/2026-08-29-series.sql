-- Chips — series: the 2026-08-29 migration.
--
-- Run this once in the Supabase SQL editor, on a database that already has
-- chips-schema.sql. Safe to re-run: every statement is guarded or is a
-- CREATE OR REPLACE.
--
-- ############################################################################
-- RUN THIS BEFORE DEPLOYING THE CODE THAT SHIPS ALONGSIDE IT.
--
-- Section 5 backfills every existing session into the series 'DW-2026-07'. Until
-- it has run, every session ever played has series_id NULL — which is precisely
-- what api/keep-alive.js deletes after five days. Deploying the code first puts
-- the whole history one cron run away from the purge's candidate list.
--
-- (The purge also ships switched off, so PURGE_ENABLED being unset is a second
-- belt on the same trousers. Do not set it until this has run and section 6
-- returns zero.)
-- ############################################################################
--
-- What this does, in order:
--   1. the series table
--   2. sessions.series_id
--   3. lifetime_stats and session_results gain series_id
--   4. player_stats_source stops counting single sessions  (separate file)
--   5. backfill: everything played so far becomes DW-2026-07
--   6. verify
--
-- Sections 3 and 4 are copies of definitions that live in chips-schema.sql and
-- player-stats.sql. Those files remain the source of truth; this is a snapshot of
-- them taken on the date in the filename, which is what a migration is.


-- ---------------------------------------------------------------------------
-- 1. THE SERIES TABLE
-- ---------------------------------------------------------------------------
-- A named run of sessions that share a leaderboard, e.g. 'DW-2026-07'. Rows are
-- kept forever once ended — three small columns, and /chips/leaderboard lists them
-- as the series directory.

create table if not exists series (
  id uuid primary key default gen_random_uuid(),
  -- 2-5 letter prefix chosen at creation, then the month it started: 'DW-2026-07'.
  name text not null unique,
  -- 'ended' removes it from the new-game screen. Set by phase one of end-series,
  -- before the archive is taken, so nothing can join mid-archive.
  status text not null default 'live' check (status in ('live', 'ended')),
  created_at timestamptz not null default now(),
  ended_at timestamptz
);

alter table series enable row level security;

drop policy if exists "anon full access" on series;
create policy "anon full access" on series for all to anon using (true) with check (true);

grant all on table series to anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. sessions.series_id
-- ---------------------------------------------------------------------------
-- NULL means a one-off session: game-over screen only, no leaderboard, no
-- contribution to anyone's profile, deleted after five days.
--
-- ON DELETE SET NULL, not CASCADE: dropping a series row must never take its
-- sessions with it.

alter table sessions add column if not exists series_id uuid references series(id) on delete set null;
create index if not exists sessions_series_idx on sessions (series_id);


-- ---------------------------------------------------------------------------
-- 3. lifetime_stats AND session_results GAIN series_id
-- ---------------------------------------------------------------------------
-- Appended last in both, because CREATE OR REPLACE VIEW only permits ADDING
-- columns to the end. In lifetime_stats it also joins the GROUP BY, which changes
-- the grain: the board is per-series now, so a player who has played in two series
-- gets two rows and each row's totals are that series' alone.

-- lifetime_stats: per-identity aggregates over ended sessions.
--
-- Written as CREATE OR REPLACE so this statement is also the migration: re-run it
-- on an existing database to pick up new columns. Postgres only allows *appending*
-- columns to a replaced view, which is why times_first sits at the end rather than
-- next to times_last where it reads more naturally.
create or replace view lifetime_stats as
-- Best and worst net at each table, computed once per session rather than as a
-- correlated subquery per player. Deliberately spans EVERY seat, including ones with
-- no identity: a guest who wins the session really did win it, and should deny the
-- credit to everyone else rather than handing second place a first.
with session_extremes as (
  select
    session_id,
    min(stack - total_buyin) as worst_net,
    max(stack - total_buyin) as best_net
  from players
  group by session_id
)
select
  pi.id as identity_id,
  pi.display_name,
  count(distinct p.session_id) as sessions_played,
  coalesce(sum(p.stack - p.total_buyin), 0) as total_net,
  coalesce(max(p.stack - p.total_buyin), 0) as biggest_win,
  -- Placement is by NET (stack − buy-in), never raw stack: with rebuys in play the
  -- biggest stack at the table can belong to the session's biggest loser — three rebuys
  -- deep and up from their last one is still down overall. Same grading as the
  -- placement column in analytics-export.sql. A tie counts for everyone level at the
  -- bottom (and times_first treats a tie at the top the same way).
  --
  -- best_net <> worst_net is what makes a session a CONTEST. Without it two degenerate
  -- shapes hand out credits nobody earned, and both occur in real data:
  --   * a one-player session — min and max are the same person, so they collect a
  --     first AND a last for sitting alone;
  --   * a session nobody played, every seat flat at zero — every player at the table
  --     collects both, which inflates whoever attends most.
  -- Neither is a placement, so a session with no spread now awards nothing to anyone.
  count(*) filter (
    where se.best_net <> se.worst_net
      and p.stack - p.total_buyin = se.worst_net
  ) as times_last,
  coalesce(sum(p.total_buyin), 0) as total_buyin,
  -- Sessions this player finished with the best net result at the table.
  count(*) filter (
    where se.best_net <> se.worst_net
      and p.stack - p.total_buyin = se.best_net
  ) as times_first,
  -- Times this player pushed their whole stack in BY CHOICE: a bet, raise or call that
  -- left nothing behind (events.all_in).
  --
  -- Blind posts are excluded even though they carry the same flag. Being short enough
  -- that a forced blind swallows your stack is not a decision, and counting it would
  -- rank the column by who most often plays down to the felt — which is what times_last
  -- already measures. What this column is for is the opposite: who chooses to shove.
  --
  -- Counted per player ROW and then summed per identity, so it survives an identity
  -- merge (events point at player rows, and merging only repoints players.identity_id).
  -- Cast because sum() over bigint yields numeric, and PostgREST hands numeric back as
  -- a JSON string; every other column on this view arrives as a number and the client
  -- sorts on it arithmetically.
  coalesce(sum((
    select count(*)
    from events e
    where e.player_id = p.id
      and e.all_in
      and e.type in ('bet', 'raise', 'call')
  )), 0)::int as all_ins,
  -- Which series these figures belong to. Appended last because CREATE OR REPLACE
  -- only permits ADDING columns to a view, never reordering them — the same reason
  -- times_first sits away from times_last above.
  --
  -- Added 2026-08. This column also changes the GRAIN of every row: the board is
  -- now per-series, so a player who has played in two series gets two rows and
  -- their sessions_played / total_net / times_first are that series' figures, not
  -- their lifetime ones. Sessions with a NULL series_id (one-offs) still appear;
  -- the client filters them out with .eq('series_id', …), and the purge removes
  -- them within five days.
  s.series_id
from players_identity pi
join players p on p.identity_id = pi.id
join sessions s on s.id = p.session_id and s.status = 'ended'
join session_extremes se on se.session_id = p.session_id
group by pi.id, pi.display_name, s.series_id;

-- session_results: one row per player per ended session — the per-session grain the
-- lifetime board can't show. Backs the net chart (cumulative net over time) and the
-- chaos score (volatility of a player's results).
--
-- Like lifetime_stats this is CREATE OR REPLACE so the statement doubles as its own
-- migration; re-run it on an existing database to add the view.
--
-- net_bb normalises a session's result to big blinds. Raw net is not comparable across
-- stakes — a 5/10 tournament dwarfs a 1/2 cash game — so anything that averages or
-- takes a standard deviation across sessions must use net_bb, not net.
--
-- The divisor is the session's STARTING big blind (blind_schedule's first rung), NOT
-- sessions.big_blind: escalation rewrites big_blind in place throughout the session, so
-- by the end it holds whatever rung the session finished on — often 2-8x where it
-- started, and higher exactly on the wild sessions with eliminations. Dividing by the
-- final blind shrank precisely the results the chaos score exists to surface, and made
-- two sessions at the same starting stakes incomparable. Sessions that predate blind schedules
-- have an empty schedule and fall back to big_blind, which for them never changed.
create or replace view session_results as
select
  p.identity_id,
  coalesce(pi.display_name, p.display_name)                                  as display_name,
  s.id                                                                      as session_id,
  s.created_at,
  s.big_blind,
  p.stack - p.total_buyin                                                   as net,
  round((p.stack - p.total_buyin)::numeric
        / nullif(coalesce((s.blind_schedule -> 0 ->> 'big_blind')::numeric,
                          s.big_blind), 0), 2)                              as net_bb,
  -- Added 2026-08, appended last for the same CREATE OR REPLACE reason as above.
  -- The net chart and the chaos score are per-series; the client filters on this.
  s.series_id
from players p
join sessions s on s.id = p.session_id and s.status = 'ended'
left join players_identity pi on pi.id = p.identity_id
where p.identity_id is not null;

-- ---------------------------------------------------------------------------
-- 4. player_stats_source STOPS COUNTING SINGLE SESSIONS
-- ---------------------------------------------------------------------------
-- Not repeated here: it is a few hundred lines of ledger reconstruction. Run all
-- of supabase/player-stats.sql, which is idempotent (create or replace view,
-- create materialized view if not exists, create index if not exists, create or
-- replace function).
--
-- It matters as much as anything above. Single sessions are deleted after five
-- days, so if their hands were counted there, the next refresh_player_stats()
-- would silently subtract them — and api/profile.js decides whom to rewrite by
-- comparing current figures against the ones each profile was written from, so
-- that subtraction reads as drift and buys a paid full-table rewrite caused by
-- nothing but a scheduled delete.
--
--     >>> RUN supabase/player-stats.sql NOW, BEFORE CONTINUING. <<<


-- ---------------------------------------------------------------------------
-- 5. BACKFILL: EVERYTHING PLAYED SO FAR BECOMES DW-2026-07
-- ---------------------------------------------------------------------------
-- Everything up to now was one continuous leaderboard, so it all becomes one
-- series. On day one this changes nothing anyone can see: every ended session is
-- in DW-2026-07, so both views filtered to it return exactly the rows they
-- returned before.

insert into series (name, status) values ('DW-2026-07', 'live')
  on conflict (name) do nothing;

update sessions
   set series_id = (select id from series where name = 'DW-2026-07')
 where series_id is null;

-- player_stats is a MATERIALIZED snapshot, so it holds stale rows until refreshed.
select refresh_player_stats();


-- ---------------------------------------------------------------------------
-- 6. VERIFY — both must be true before the code deploys
-- ---------------------------------------------------------------------------
-- orphans must be 0. Anything left NULL is invisible on every board AND five days
-- from deletion.
select count(*) filter (where series_id is null)     as orphans,
       count(*) filter (where series_id is not null) as in_a_series,
       count(*)                                      as total
  from sessions;

-- The board should be unchanged: one row per player, all of them in DW-2026-07.
select display_name, sessions_played, total_net, series_id
  from lifetime_stats
 order by total_net desc;
