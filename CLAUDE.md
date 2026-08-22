# keogan.ca4 — notes for future edits

Astro site (`output: 'static'`) deployed on Vercel. Auto-deploys on push to
`main`. See README.md for the /chips app.

## API endpoints — IMPORTANT gotcha

Because the site is `output: 'static'`, **Astro server routes in
`src/pages/api/` do NOT deploy** — they return 404 in production even with
`prerender = false`. The root `api/` directory (Vercel's native serverless
functions) owns the `/api/*` namespace instead.

**Rule: every backend endpoint goes in the root `api/` folder** as a native
Vercel function (`export default async function handler(req, res)`, using
`process.env`, NOT `import.meta.env`). Copy `api/keep-alive.js` as the template.
Do not add endpoints under `src/pages/api/` — they will silently 404.

(This is exactly how the guestbook notify endpoint was broken for its whole
life until it was ported from `src/pages/api/notify.ts` to `api/notify.js`.)

Current endpoints:
- `api/keep-alive.js` — daily Vercel cron (see vercel.json) that pings Supabase
  so the free-tier project doesn't pause. **Load-bearing:** if it stops, the DB
  eventually pauses and guestbook + /chips + notify all go down together.
- `api/notify.js` — Supabase Database Webhook target. Fires on new
  `guestbook_entries` rows and emails via Resend.
- `api/profile.js` — Supabase Database Webhook target. Fires on `sessions`
  UPDATE, acts only on the transition into `ended`, and rewrites the generated
  player profiles for anyone whose numbers have moved. See "Generated text" below.
- `api/recap.js` — called from the browser by the game-over screen; streams the
  session recap. The only endpoint reachable without a secret.

Shared, not endpoints (a leading underscore keeps them off the `/api/*` routes —
this is load-bearing: `api/profile.test.js` was briefly deployed as a live
function at `/api/profile.test` returning 500, which is why the test files are
named `_profile.test.js` and `_recap.test.js`):
- `api/_supabase.js` — `db()`, `json()`, `countOf()` over the REST API.
- `api/_prompts.js` — **the prompts that actually ship.** Single source: the
  prompt lab reads this file and runs it as its "shipped" column, so a variant is
  always compared against what is live. Edit here to change what the app says.
- `api/_drift.js` — decides whose profile is stale enough to be worth rewriting.

## Guestbook email flow

Guestbook page (`src/pages/guestbook.astro`) inserts rows into Supabase
directly from the client. A **Supabase Database Webhook** (configured in the
Supabase dashboard, NOT in this repo) POSTs each new row to
`https://keogan.ca/api/notify`, which sends an email via Resend.

Dependencies that live OUTSIDE this repo and can break the flow with no code
change — check these first if emails stop:
- **Vercel env vars:** `NOTIFY_SECRET`, `RESEND_API_KEY` (Production scope).
- **Supabase webhook config:** URL must be `/api/notify`, must send header
  `x-webhook-secret` matching `NOTIFY_SECRET`, on INSERT to `guestbook_entries`.
- **Resend:** the API key + the `from:` sender in `api/notify.js`.

`api/notify.js` returns Resend's error detail in its 500 response, so Vercel
function logs will show the real reason on failure (401 = secret mismatch;
500 with detail = Resend key/sender problem).

## Generated text: profiles, coaching, recaps

Three pieces of writing, all Claude Opus 5, all from `api/_prompts.js`:

- **Profile** — one or two lines under each name on the leaderboard's profiles tab.
- **Coaching** — "what to work on", shown only inside your own expanded card.
- **Recap** — a paragraph on the game-over screen when a session ends.

**Profiles and coaching cost nothing on most sessions.** When `api/profile.js`
fires it compares each player's current figures against `player_profiles.stats_snapshot`
— the numbers their existing text was written from — in plain JavaScript, and
returns without calling the model if nobody has moved past the thresholds in
`api/_drift.js`. When someone has, ONE call carries the whole table (every
player's stats and every current profile) with only the drifted players named for
rewriting: the funniest lines are comparisons, and those need the whole table in
view.

Only players who were IN the session that just ended are candidates. That is
mostly redundant, but it is the safeguard that matters if the `player_stats`
arithmetic is ever corrected: without it, one fix would rewrite every profile at
once. With it, each catches up as its player next sits down.

**The recap is reachable from a browser** and so cannot hold a secret. Its
protection is structural: the session must exist, have ENDED, have at least 2
players and 5 dealt hands, and have no recap yet. That last one caps spend at one
generation per session, ever. The row is claimed before generating so two open
screens do not both pay, and a failed run deletes its own claim so the next visit
retries.

Fast mode is opt-in via `FAST_MODE=1` and defaults OFF: it is a research preview,
and an org without access gets a hard 429 naming a limit of zero rather than
slower output. Standard speed streams the first token in about 2s.

Dependencies OUTSIDE this repo, same as the guestbook flow:
- **Vercel env vars:** `ANTHROPIC_API_KEY`, `PROFILE_SECRET` (Production scope).
- **Supabase webhook:** `sessions` UPDATE → `https://keogan.ca/api/profile`, with
  header `x-webhook-secret` matching `PROFILE_SECRET`.
- **Migrations:** `supabase/player-profiles.sql`, `supabase/session-recaps.sql`.

## player_stats is a snapshot, not a view

`supabase/player-stats.sql` defines `player_stats_source` (the query) and
`player_stats` (a MATERIALIZED snapshot of it). Read the snapshot; never point
anything at the source. The source cannot be planned — the planner estimates its
first stage at ~13 rows when it returns thousands and nested-loops all the way up,
taking over two minutes on a ledger each stage handles in milliseconds, so every
Data API query against it failed on the 3-second statement timeout. The full
diagnosis is in the file.

`refresh_player_stats()` rebuilds it (~70ms) and carries its own planner setting so
it cannot be run without one. It is called from `endSession` in
`src/chips/lib/services/table.ts` and again by `api/profile.js`, which is
deliberate belt-and-braces: the client call is fire-and-forget so a failed refresh
can never surface to the host as "ending the game failed".

## Tuning the prompts

`scripts/prompt-lab/` — see its README. The fast loop is `npm run lab:table`,
which prints live stats as a pasteable markdown table for an ordinary Claude chat;
that is how the current profile prompt was arrived at. `npm run lab` is for
comparing variants against the shipped prompt with repeats and across models.
