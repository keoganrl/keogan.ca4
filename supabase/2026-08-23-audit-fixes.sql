-- Chips — schema changes from the 2026-08-23 audit.
--
-- Run this once in the Supabase SQL editor, after chips-schema.sql. Safe to re-run:
-- every statement is guarded, and nothing here is required by the app code shipped
-- alongside it.
--
-- Two things, both unconditional:
--   1. drop three columns nothing reads
--   2. stop offering anon the un-plannable source view
--
-- The one-seat-per-identity constraint that was originally part of this file now
-- lives in supabase/one-seat-per-identity.sql, because enforcing it means first
-- deciding what to do about any duplicate seats already in the data, and that is a
-- look-at-it-first job rather than a migration step.


-- ---------------------------------------------------------------------------
-- 1. DROP THE COLUMNS NOTHING READS
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
-- 2. STOP EXPOSING player_stats_source
-- ---------------------------------------------------------------------------
-- The source view is the un-plannable one: reading it directly takes over two
-- minutes on a real ledger and Supabase's Data API kills it at three seconds (see
-- the note at the foot of player-stats.sql). Nothing reads it through the API —
-- everything reads the materialised player_stats — so the grant only offers
-- strangers a way to tie up a database connection. Revoked from the API roles;
-- refresh_player_stats() is security definer and keeps working, and anyone with SQL
-- access can still query the view directly.
revoke select on player_stats_source from anon, authenticated;
