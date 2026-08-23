-- Chips — OPTIONAL: make the generated text writable only by the API functions.
--
-- ---------------------------------------------------------------------------
-- DO NOT RUN THIS UNTIL SUPABASE_SERVICE_ROLE_KEY IS SET IN VERCEL
-- ---------------------------------------------------------------------------
-- Running it first will break profiles and recaps in production: the functions
-- fall back to the publishable key, and this script is what takes that key's
-- write access away. Order matters.
--
--   1. Supabase dashboard → Project Settings → API → service_role key (secret).
--   2. Vercel → Project → Settings → Environment Variables → add
--      SUPABASE_SERVICE_ROLE_KEY, Production scope. It is a SECRET key: it
--      bypasses RLS entirely, so it belongs nowhere near the browser bundle.
--      Never give it the PUBLIC_ prefix — Astro exposes those to the client.
--   3. Redeploy (env vars are read at cold start).
--   4. Run this file.
--
-- To undo, re-run supabase/player-profiles.sql and supabase/session-recaps.sql,
-- which restore the open grants.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS CHANGES, AND WHAT IT DOES NOT
-- ---------------------------------------------------------------------------
-- The chips tables are anon-writable on purpose: there are no accounts, the
-- publishable key ships in the JavaScript every visitor downloads, and the app
-- writes game state straight from the browser. That trust model is fine for game
-- state, which the people at the table are entitled to change anyway.
--
-- The two generated-text tables are different in one respect: they are the only
-- tables whose contents cost money to produce, and the only ones nobody at the
-- table is supposed to write by hand. Leaving them anon-writable means anyone
-- holding the publishable key can rewrite a profile to say whatever they like, or
-- delete a stored recap — and deleting a recap resets the "one generation per
-- session, ever" cap that keeps the recap endpoint from being a spend button.
--
-- After this, reads stay wide open (the leaderboard and the game-over screen need
-- them) and every write goes through api/profile.js and api/recap.js.
--
-- This does NOT stop someone fabricating sessions to make the recap endpoint
-- generate: that is what the DAILY_CAP in api/recap.js is for, and ultimately what
-- a spend limit on the Anthropic workspace is for. It removes the free reset.

revoke insert, update, delete on player_profiles from anon, authenticated;
revoke insert, update, delete on session_recaps  from anon, authenticated;

-- RLS policies gate rows; the grants above gate the verb. Both have to agree, so
-- narrow the policies to match rather than leaving a for-all policy that now
-- describes access nobody has.
drop policy if exists "player_profiles are public" on player_profiles;
create policy "player_profiles are readable by everyone" on player_profiles
  for select using (true);

drop policy if exists "session_recaps are public" on session_recaps;
create policy "session_recaps are readable by everyone" on session_recaps
  for select using (true);

-- The service role bypasses RLS, so the functions keep full access with no policy
-- of their own. Stated explicitly because the grant is what they actually rely on.
grant select, insert, update, delete on player_profiles to service_role;
grant select, insert, update, delete on session_recaps  to service_role;
