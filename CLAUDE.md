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
  eventually pauses and guestbook + /chips + notify all go down together. It also
  runs the five-day purge of single sessions — see "Deleting /chips data" below.
  The ping runs first and unchanged, and a failing purge cannot take it down.
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
- `api/_supabase.js` — `db()`, `json()`, `countOf()` over the REST API. Uses
  `SUPABASE_SERVICE_ROLE_KEY` when that is set, the publishable key otherwise (see
  "Locking down the generated text").
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

A claim is only honoured for three minutes. A function killed between claiming the
row and storing the text (a timeout, a crash) never runs its own cleanup, and the
null row it leaves behind would answer "already generating" forever; past the
timeout the next visit takes the claim over.

Fast mode is opt-in via `FAST_MODE=1` and defaults OFF: it is a research preview,
and an org without access gets a hard 429 naming a limit of zero rather than
slower output. Standard speed streams the first token in about 2s.

**Single sessions get a recap, but nothing else.** The recap is about the session in
front of you — `RECAP` in `_prompts.js` never mentions a series, a leaderboard or
standings — so a one-off reads exactly like any other session and belonging to a
series is not one of its preconditions. It draws on the same `DAILY_CAP`, which at a
few games a month is nowhere near binding.

What a single session still does NOT do is move anybody's profile. `api/profile.js`
skips them in the same guard that ignores non-endings, and `player_stats_source`
excludes them outright, so one-off play cannot reach VPIP, coaching or the profiles
tab at all. The two are independent: the recap only READS profiles, it never writes
them. A single session's recap row cascades away with the session at the five-day
purge, which is right — it belonged to a game-over screen that no longer has results
to show.

### What actually bounds the spend

Be clear-eyed about the guards above: the chips tables are anon-writable by design
and the publishable key ships in the browser bundle, so a determined stranger can
manufacture a session that satisfies "ended, 2 players, 5 dealt hands". The
per-session checks stop accidents and casual abuse. What bounds the money is:

1. **A spend limit on the Anthropic workspace.** Set in the console, outside this
   repo, and the only control that cannot be reasoned around. Do this.
2. **`DAILY_CAP` in `api/recap.js`** (20 recaps/day across all sessions) and
   **`DAILY_PROFILE_CAP` in `api/profile.js`** (60 profiles/day). Both are roughly
   twenty times normal use, so playing poker will never reach them.
3. **Drift gating**, which is why a quiet session costs nothing at all. This is
   what keeps the PROFILE side cheap; the recap has no equivalent, because a recap
   is written once per session and then never again.

### Locking down the generated text

`player_profiles` and `session_recaps` are the only tables whose contents cost
money to make, and the only ones nobody at the table should be writing by hand.
They ship anon-writable like everything else, which means the publishable key can
rewrite a profile or DELETE a stored recap — and deleting the recap row resets the
one-generation-per-session cap.

`supabase/lock-down-generated-text.sql` closes that, but **only run it after
setting `SUPABASE_SERVICE_ROLE_KEY` in Vercel and redeploying** — it revokes the
write access the functions otherwise rely on. Order matters; the file spells it
out. Reads stay open either way.

Dependencies OUTSIDE this repo, same as the guestbook flow:
- **Vercel env vars:** `ANTHROPIC_API_KEY`, `PROFILE_SECRET` (Production scope).
- **Supabase webhook:** `sessions` UPDATE → `https://keogan.ca/api/profile`, with
  header `x-webhook-secret` matching `PROFILE_SECRET`.
- **Migrations:** `supabase/player-profiles.sql`, `supabase/session-recaps.sql`.
- **Optional:** `SUPABASE_SERVICE_ROLE_KEY` (Production, SECRET — never `PUBLIC_`).

### One screen generates, every screen watches

`api/recap.js` claims the `session_recaps` row before calling the model, so exactly
one phone streams a given recap and the rest get a 202. Those phones do two things
at once (`src/chips/components/Cashout.svelte`):

- **Live text** comes over a Supabase realtime BROADCAST channel, `recap:<sessionId>`,
  relayed by the generating phone as it reads (`lib/utils/recapRelay.ts`). Broadcast
  is ephemeral pub/sub over the websocket the app already holds — no table, no
  publication change, nothing to migrate. Messages carry the WHOLE paragraph so far
  rather than deltas, so a dropped, late or out-of-order one repairs itself and a
  phone that subscribes late catches up on its first message. Receivers keep whichever
  text is longer.
- **The stored copy** is polled underneath it (`lib/utils/recapPolling.ts`), which is
  what makes the relay optional: if the generating phone locked, left, or finished
  before this one subscribed, the finished text still arrives. The poll also doubles
  as the "generation finished" signal, since the row is only written at the end.

The two are raced, so the caret stops on the relay's final message when there is one
and on the poll when there is not. Before this, the 202 was read as JSON, found no
`recap` key, and left every phone but the first showing nothing until a reload.

## /chips series, and deleting data

A session is either a one-off (`sessions.series_id` null) or part of a named series.
Single play gets a game-over screen and nothing else: no leaderboard, no recap, no
contribution to anyone's profile, and it is deleted after five days. Series play
works as the leaderboard always did, scoped to one series. README.md has the user-
facing description, the URL scheme, and the runbook.

Ending a series is a **protocol, not a feature**. There is no UI for it and there
should not be. `scripts/end-series.mjs`, run in two separate invocations with a human
looking at a deployed page in between; the header of that file explains why the two
phases cannot be one command.

Two things that cost time the first time this was run for real:

- **Reads must page.** PostgREST caps a GET at 1000 rows and says nothing about it,
  so anything that has to be COMPLETE goes through `jsonAll()` in `api/_supabase.js`,
  never `json()`. The first archive of DW-2026-07 wrote a backup holding 1000 of its
  4947 events and looked perfectly healthy doing it. `jsonAll` demands an `order=`
  clause because paging an unordered query overlaps and skips rows instead — wrong
  rather than merely short. Phase one now re-counts every table off `Content-Range`
  and refuses to write a dump that disagrees.
- **From an agent sandbox, Node needs `NODE_USE_ENV_PROXY=1`.** `curl` picks up
  `HTTPS_PROXY` on its own; Node's fetch does not, and the egress proxy answers the
  direct connection with `403 Host not in allowlist`, which reads like a Supabase
  permissions problem and is not one. Irrelevant on a normal machine.

### Deleting /chips data

Until series shipped, the only DELETE in this repo removed ghost `players_identity`
rows during a merge. There are now exactly **two** places allowed to delete /chips
data, and nothing else should ever grow the ability:

- `api/keep-alive.js` — the five-day purge of single sessions (decision logic in
  `api/_purge.js`).
- `scripts/end-series.mjs --confirm` — the end-of-series wipe.

The rules both follow, and that any future deletion path must follow:

1. **Delete by explicit primary-key list, never by filter.** A filter travels as a
   query string and a lost parameter does not error, it widens the result:
   `DELETE /sessions?series_id=is.null` that loses its filter matches every session
   ever played. A list of ids cannot mean anything but those ids.
2. **Re-assert the predicate on the rows that came back**, before deleting them. That
   is the only place a widened result is visible.
3. **Refuse rather than correct.** An unexpected row, an oversized set, a cutoff in
   the future: delete nothing and report why. `api/_purge.js` is entirely this.
4. **Archive first, and verify the archive is deployed** before deleting anything.
5. **Never run a destructive statement against production while developing.** Use a
   separate project, or rows you created for the test and identified by id.

`players`, `rebuys`, `hands`, `events` and `session_recaps` all declare
`ON DELETE CASCADE` on `sessions`, so **one session row takes that session's entire
ledger with it** — every blind, bet, call and fold. There is no undo and no soft
delete anywhere in this schema. `player_stats` compounds it: deleted rows sit in the
snapshot until the next `refresh_player_stats()` and then vanish with nothing marking
the change, which is why the wipe refreshes it explicitly.

`series` rows are kept forever once ended — three small columns, and
`/chips/leaderboard` lists them as the directory. `player_profiles` survives a wipe
too: profiles are per-identity, so the next series opens with everyone's existing
blurb and the drift check rewrites them off the new series' hands.

## Poker rules this app implements

Mostly standard, with two deliberate house simplifications. If you change any of
these, `src/chips/lib/utils/betting.ts` and `seatOrder.test.ts` are where the rules
are actually pinned down.

- **Heads-up: the button posts the small blind**, acts first preflop and last
  afterwards. Standard everywhere. (Until 2026-08 this app had it backwards — the
  dealer on the big blind — so heads-up hands played before then reconstruct with
  SB and BB swapped in `player_stats`. Nothing else is affected.)
- **A short all-in does not reopen the betting.** An all-in for less than a full
  raise leaves players who have already acted with call-or-fold only:
  `facingShortAllIn` reads it off the ledger, `canRaise` hides the raise panel, and
  `placeBet` refuses it. Crucially `placeBet` also stops clearing everyone's
  `acted_on_street` in that case — clearing it is what "reopened" means here.
- **HOUSE RULE — minimum raise is DOUBLE the current bet**, not the standard
  current-bet-plus-last-increment (which is smaller in a re-raised pot). Easier to
  explain across a kitchen table. `minRaiseTotal` is the one definition; the short
  all-in test uses it too, so the two cannot disagree about what a full raise is.
- **HOUSE RULE — voided and reset hands still count in the stats.** The chips go
  back, but the decisions were real, so VPIP/PFR/AF keep them.
- **Dead button**: someone who busts or leaves mid-hand keeps the button on their
  seat until the next deal, so the blinds do not shift under a hand in progress.
  Everything that orders play goes through `buttonIndexIn` for this.

## Invariants worth not breaking

- **Chip conservation.** `sum(stacks) + pot == sum(buy-ins)` at every settled
  moment. The table banner watches it, `supabase/session-audit.sql` finds where it
  broke, and `supabase/repairs/` is what fixing it afterwards costs.
- **Never write an absolute stack from the realtime cache.** Every function that
  writes `stack`, `total_buyin` or `pot` as a value rather than a delta re-reads the
  row first. This is not defensive habit; it is the cause of every chip-minting bug
  this app has had. `callBet`, `awardPot`, `awardPayouts`, `adjustChips`,
  `giveChips`, `doRebuy`, `endHand`, `redealHand` and `reorderSeats` all do it, and
  `chipMoves.test.ts` holds the mock honest by making the cache disagree with the
  database on purpose.
- **One seat per identity per session**, enforced by a unique index (added in
  `supabase/one-seat-per-identity.sql`). `joinSession` treats losing the insert race
  as a rejoin. The index is also why merging identities goes through the
  `merge_identities()` SQL function rather than two statements from the client:
  merging someone who played one session under two identities gives the survivor two
  chairs in that session, and those have to be folded into one before the repoint,
  or it violates the index and the client silently no-ops. `merge_seats()` does the
  folding — stacks and buy-ins add, and every reference is repointed BEFORE the row
  goes, because `events.player_id` is ON DELETE SET NULL and an ownerless event
  drops out of its hand's ring in `player_stats`.
- **Seat order is not unique**, so every ordering goes through `bySeat` in
  `src/chips/lib/utils/seat.ts`, which breaks ties by id. Two clients disagreeing
  about turn order is the failure this prevents.

## player_stats is a snapshot, not a view

`supabase/player-stats.sql` defines `player_stats_source` (the query) and
`player_stats` (a MATERIALIZED snapshot of it). Read the snapshot; never point
anything at the source.

**The source counts ended SERIES sessions only.** Single sessions are excluded, and
the second reason is the one that costs money if you undo it: they are deleted after
five days, so if their hands were counted here, the next `refresh_player_stats()`
would silently subtract them — and `api/profile.js` decides whom to rewrite by
comparing current figures against the ones each profile was written from, so that
subtraction reads as drift and buys a full-table rewrite caused by nothing but a
scheduled delete. The source cannot be planned — the planner estimates its
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
