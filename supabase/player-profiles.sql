-- Chips — generated player profiles and coaching.
--
-- Run this AFTER chips-schema.sql and player-stats.sql. Safe to re-run: the table
-- is IF NOT EXISTS, so an existing one keeps its generated text.
--
-- One row per lifetime identity, holding the two pieces of writing shown on the
-- profiles tab and the numbers they were written from.
--
-- stats_snapshot is the load-bearing column. Before any model call, api/profile.js
-- compares each player's current figures to the snapshot stored here and rewrites
-- only those that have moved past a threshold. Without it there is no way to ask
-- "is this text still true?" without asking the model, which would mean paying for
-- an answer that is usually no after a session where nothing changed.

create table if not exists player_profiles (
  identity_id    uuid primary key references players_identity (id) on delete cascade,

  -- The short blurb everyone sees on the profiles tab.
  profile        text,
  -- The longer "what to work on", shown only to the player themselves.
  coaching       text,

  -- The figures the two texts above were written from: {vpip_pct, pfr_pct,
  -- wtsd_pct, af}. Compared against player_stats to decide staleness.
  stats_snapshot jsonb,

  -- Which session's ending produced this text. Handy when a profile reads oddly
  -- and you want to see the session that caused it.
  generated_from uuid references sessions (id) on delete set null,
  generated_at   timestamptz not null default now()
);

-- Same wide-open posture as the rest of the chips tables: the app has no accounts,
-- and the profiles are read by everyone at the table anyway. Writes go through
-- api/profile.js, which is reached only by the Supabase webhook and checks a shared
-- secret — this grant is what lets the page READ them.
alter table player_profiles enable row level security;

drop policy if exists "player_profiles are public" on player_profiles;
create policy "player_profiles are public" on player_profiles
  for all using (true) with check (true);

grant select, insert, update on player_profiles to anon, authenticated, service_role;
