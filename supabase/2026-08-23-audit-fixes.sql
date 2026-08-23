-- Chips — schema changes from the 2026-08-23 audit.
--
-- Run this once in the Supabase SQL editor, after chips-schema.sql. Safe to re-run:
-- every statement is guarded. Nothing here is required by the app code shipped
-- alongside it — the app works without it — but the unique index is what actually
-- enforces one seat per person, rather than merely making the race unlikely.
--
-- Three things:
--   1. one seat per identity per session (a real constraint, not a convention)
--   2. drop three columns nothing reads
--   3. stop offering anon the un-plannable source view


-- ---------------------------------------------------------------------------
-- 1. ONE SEAT PER IDENTITY PER SESSION
-- ---------------------------------------------------------------------------
-- joinSession reads "have you got a seat here already?" and then inserts, which is
-- two round trips with a gap in the middle. Two tabs (or a double-tap on a slow
-- connection) both read "no" and both insert, and one person ends up holding two
-- seats: two stacks, two buy-ins, and a leaderboard net that counts them twice.
--
-- identity_id is nullable and NULLs do not conflict in a unique index, so guest
-- seats with no identity are unaffected — any number of them can share a session.
--
-- The index cannot be created while duplicates exist, and a bare failure here reads
-- like a broken migration rather than data that needs a decision. So look first and
-- say plainly what is wrong. If this raises, the query in the message lists the
-- affected seats: merge them by hand (usually: move the chips onto one row and
-- delete the other) and re-run.
do $$
declare
  dupes int;
begin
  select count(*) into dupes from (
    select session_id, identity_id
    from players
    where identity_id is not null
    group by session_id, identity_id
    having count(*) > 1
  ) d;

  if dupes > 0 then
    raise exception
      'players holds % duplicate (session_id, identity_id) group(s); the unique index cannot be created until they are merged. List them with: select session_id, identity_id, count(*), array_agg(id) from players where identity_id is not null group by 1, 2 having count(*) > 1;',
      dupes;
  end if;
end
$$;

create unique index if not exists players_session_identity_idx
  on players (session_id, identity_id);


-- ---------------------------------------------------------------------------
-- 2. DROP THE COLUMNS NOTHING READS
-- ---------------------------------------------------------------------------
-- All three have been written by nothing and read by nothing for the life of the
-- app. sessions.host_player_id was superseded by players.is_host (which is what
-- claimHost moves around), and last_active_at by players.last_heartbeat_at.
--
-- players_identity.email is the one worth actually removing rather than ignoring.
-- No screen collects it and no code path sets it, but the table is anon-writable by
-- design, so the column is a place email addresses could accumulate without anyone
-- deciding they should. A column that cannot hold personal data is easier to reason
-- about than one that merely happens to be empty.
alter table sessions          drop column if exists host_player_id;
alter table sessions          drop column if exists last_active_at;
alter table players_identity  drop column if exists email;


-- ---------------------------------------------------------------------------
-- 3. STOP EXPOSING player_stats_source
-- ---------------------------------------------------------------------------
-- The source view is the un-plannable one: reading it directly takes over two
-- minutes on a real ledger and Supabase's Data API kills it at three seconds (see
-- the note at the foot of player-stats.sql). Nothing reads it through the API —
-- everything reads the materialised player_stats — so the grant only offers
-- strangers a way to tie up a database connection. Revoked from the API roles;
-- refresh_player_stats() is security definer and keeps working, and anyone with SQL
-- access can still query the view directly.
revoke select on player_stats_source from anon, authenticated;
