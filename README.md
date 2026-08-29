# keogan.ca4
updated version of personal website

## /chips

A poker-session chip tracker (ported from the standalone poker-tracker project),
living at `keogan.ca/chips`. Unlinked from the main site and excluded from the
sitemap. The Svelte app lives in `src/chips/` (components + game logic) with
Astro pages in `src/pages/chips/`; the invite routes (`/chips/WOLF` etc.) are
prerendered from the fixed join-code word pool.

It uses the same Supabase project as the guestbook (via the existing
`PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_ANON_KEY` env vars — no extra
config). One-time setup: run `supabase/chips-schema.sql` in that project's
SQL editor. It creates the game tables, the `lifetime_stats` view, open anon
RLS policies, the required Data API grants, and enables realtime on
`sessions`, `players`, and `events`.

#### Migrations, in order

Fresh install: run 1-5; 6 is for existing databases only. An existing database:
run whichever it has not had. Every file is safe to re-run except `chips-schema.sql`,
which creates tables unguarded and is an install script rather than a migration.

1. `supabase/chips-schema.sql` — tables, `lifetime_stats`, `session_results`, RLS,
   grants, realtime.
2. `supabase/player-stats.sql` — the extended stats snapshot and its refresh
   function.
3. `supabase/player-profiles.sql` and `supabase/session-recaps.sql` — storage for
   the generated text.
4. `supabase/2026-08-23-audit-fixes.sql` — drops three columns nothing ever read
   and stops offering `player_stats_source` to the Data API.
5. `supabase/one-seat-per-identity.sql` — the seat-merging functions, a fold of any
   duplicate seats already in the data, and the unique index that stops new ones.
   **Read the "look before you merge" query in its header first**: folding two chairs
   together adds their stacks and buy-ins, which is right for two chairs somebody
   really played and wrong for a phantom row carrying a buy-in nobody paid.
   The leaderboard's merge button calls `merge_identities()` from this file.
6. `supabase/2026-08-29-series.sql` — series. Adds the `series` table and
   `sessions.series_id`, gives both leaderboard views a `series_id`, and folds every
   session played so far into `DW-2026-07`. **Run it before deploying the code that
   ships with it:** until it has, every session ever played has `series_id` NULL,
   which is what the five-day purge in `api/keep-alive.js` looks for. A fresh
   install gets all of this from `chips-schema.sql` and should skip this file.

Optional, and only after setting `SUPABASE_SERVICE_ROLE_KEY` in Vercel:
`supabase/lock-down-generated-text.sql` makes the profile and recap tables
read-only to the browser. See CLAUDE.md.

`supabase/stats-selftest.sql` checks the stats reconstruction against a synthetic
ledger with hand-computed answers. It runs in a transaction and rolls back, so it
is safe against the live database; zero rows means pass.

### Single sessions and series

Every game is one of two things, chosen on the setup screen with **single** as the
default. The difference is one nullable column, `sessions.series_id`, and it decides
rather more than where the results show up:

|                                | single | series |
|--------------------------------|--------|--------|
| Game-over screen with results   | yes    | yes    |
| On a leaderboard                | no     | yes    |
| Recap paragraph                 | yes    | yes    |
| Feeds profiles and coaching     | no     | yes    |
| Kept                            | 5 days | until the series is ended |

The recap is the one generated thing a single session does get. It is written about
the session in front of you rather than about any standings, so a one-off reads
exactly like a series game, and the row is deleted along with the session at five
days. What a single session never does is move anybody's profile or coaching — that
is enforced in `player_stats_source`, not just in the app.

A series is named `PREFIX-YYYY-MM` — the players pick two to five letters, the
calendar supplies the rest. The month half is generated rather than typed so that
lexicographic order and chronological order are the same order, which is what lets
the directory sort on the name alone.

`/chips/leaderboard` is that directory. Each series' board is at
`/chips/<NAME>/leaderboard`, and the same URL serves two different things depending
on whether the series has ended:

- **live** — no file matches, so the `vercel.json` rewrite hands it to
  `/chips/series`, which renders it from Supabase. (`astro dev` does not apply
  rewrites, so in dev use `/chips/series?series=<NAME>`.)
- **ended** — a committed snapshot in `src/chips/archive/` prerenders it to static
  HTML with no database behind it.

Vercel only applies rewrites after the filesystem misses, so those two compose
without any ordering rules of their own. A series' URL does not change when it ends;
only the page behind it does.

**Single sessions contribute nothing to `player_stats`**, which is enforced in
`player_stats_source` rather than anywhere in the app. That is partly the
requirement and partly self-defence: single sessions are deleted after five days,
and if their hands were counted, the next `refresh_player_stats()` would silently
subtract them — which `api/profile.js` reads as drift and pays to rewrite. Excluding
them at the source means a scheduled delete cannot move anybody's numbers.

The five-day purge lives in `api/keep-alive.js` and ships **switched off**: without
`PURGE_ENABLED=1` it logs exactly what it would delete and stops. Leave it that way
for a week of cron runs, read the ids, then enable it.

### Ending a series

There is no button for this and there should not be: it deletes a season of poker.
It is a protocol an agent in this repo can run, in two separate invocations, with a
human looking at a deployed page in between.

```
npm run end-series -- DW-2026-07                       # phase one: archive
npm run end-series -- DW-2026-07 --confirm --confirm-name=DW-2026-07   # phase two: delete
```

1. **Phase one.** Marks the series `ended` first, so nothing can join it mid-archive
   — that is the only write it makes, and it is reversible. Then it writes two files:
   `src/chips/archive/DW-2026-07.json`, the committed snapshot the frozen board
   renders from, and `backups/DW-2026-07-<timestamp>.json`, a gitignored dump of
   every session, player, rebuy, hand, event, recap and profile in the series.
2. **Move the raw dump off the machine.** It is the only thing that could rebuild
   the series, and phase two refuses to run if it is not there.
3. **Commit the archive, push, wait for the deploy.**
4. **Look at the frozen board** at `keogan.ca/chips/DW-2026-07/leaderboard` and
   compare every tab against the live one.
5. **Only then, phase two.** It re-checks all of the above — the series is ended, the
   archive parses and holds standings, the raw dump exists, and the archive names the
   same sessions the database still has — then deletes by explicit id list, verifies
   that nothing outside the series moved, and refreshes `player_stats`.

**Steps 4 and 5 are not interchangeable.** `players`, `rebuys`, `hands`, `events` and
`session_recaps` all cascade from `sessions`, so phase two takes every ledger row in
the series with it. If in doubt, stop after phase one: a series marked `ended` with
its rows intact is a perfectly stable state — it takes no new sessions, its board
still renders, and nothing has been lost.

The archive deliberately omits `coaching`. It is written to be read by the player it
is about, and `src/chips/archive/` is committed to a public repository; the frozen
board shows profiles and the detailed stats panel without it. The full text is in the
raw dump.

#### Adding a session to a series afterwards

This is the whole reason single sessions are kept five days rather than deleted at
the final hand. Somebody plays a one-off, and it turns out it should have counted:

```sql
update sessions set series_id = (select id from series where name = 'DW-2026-08')
 where id = '<session uuid>';
select refresh_player_stats();
```

The refresh is not optional — `player_stats` excludes single sessions, so until it
runs, that session's hands are still missing from everybody's figures.

### When a session's numbers look wrong

`supabase/session-audit.sql` backtracks a session from its `session_id`:
find the right session (join codes are reused, so a session can split across
two rows), check that chips balance
(`sum(stack) + pot == sum(total_buyin)`), then walk the `events` ledger to
find the hand where they stopped balancing. Paste one block at a time into
the Supabase SQL editor.

### The button when somebody leaves

Standing up mid-hand folds you first: the fold is written and logged, and if the turn
was yours it moves on. Without that the table could stall with `current_actor_id`
pointing at a phone that had left the page — the client that self-corrects a
mis-aimed turn is the actor's own — and the ledger would show a hand walked out on as
a hand taken to showdown.

The button, though, does **not** move when a player stands up mid-hand. It stays on
their empty seat as a *dead button* until the next deal, exactly as it would at a real
table, and `endHand` then rotates off that seat. Rotating at the moment somebody left was the old
behaviour and it was wrong twice over: it shifted the blinds and the action order under a
hand that was already being played, and then `endHand` rotated *again*, so the button
jumped two seats and skipped whoever was next.

That means the button can point at an inactive player for the rest of a hand, so every
function that orders play goes through `buttonIndexIn` (`lib/services/table.ts`), which
places the button by *seat* rather than by position in the list of players still sitting
down. It needs the full roster — inactive rows included — which is why `getActionOrder`,
`postBlinds`, `firstPostflopActor`, `advanceStreet` and `nextButtonPlayerId` all take an
`allPlayers` argument. Handing them only the active players is what made the button
collapse back to seat 0, which is the bug people saw as "the order went funny after
someone left".

### Two rules worth knowing

**Heads-up, the button posts the small blind** and acts first before the flop, last
after it. This is the standard arrangement; the app used the reverse until 2026-08,
so heads-up hands from before then reconstruct with the two blinds swapped in
`player_stats`. Nothing else in the stats is affected.

**An all-in that is too small to be a full raise does not reopen the betting.** If
you have already acted and someone shoves for less than a real raise, you can call
the difference or fold, but you cannot raise again — otherwise a player one chip
short could be used to reopen an action that was closed. The app works this out from
the ledger (`lib/utils/betting.ts`), hides the raise button, and refuses the bet if
the panel was already open when the shove landed.

Note the minimum raise here is a house simplification: **double the current bet**,
rather than the standard current-bet-plus-last-increment. It is easier to explain at
a kitchen table and errs towards bigger raises.

### Leaderboard: net chart and chaos score

The net tab opens with a cumulative-net line chart, one line per player, over every
ended session. The list underneath is also the legend — each name carries its line's
colour, and tapping a row highlights that line and dims the rest, which is the only
thing that scales past a handful of players. Swatches appear on the net tab only:
elsewhere there is no chart to key them to, so they would be colour for its own sake.

Two rules worth knowing before editing it:

- **Colour follows the player, never their rank.** Slots are handed out in debut
  order, so a colour is stable for good. Rank-ordered colour would repaint the whole
  chart after every session and nobody could follow their own line across two visits.
- **The palette's slot order is a colourblind-safety guarantee**, validated against
  the chips paper. Don't reorder or hand-pick a replacement without re-validating.
  See the header of `src/styles/chips.css`.

`times_first` / `times_last` are graded by net, and only sessions that were an actual
contest award them: a table where the best and worst net are equal — one player sitting
alone, or a session nobody played — awards nothing rather than crediting everyone at it
with both a first and a last.

The chaos tab ranks players by the standard deviation of their per-session results,
measured in **big blinds** — raw chips would mostly rank people by which stakes they
turned up for. The figure shown is that deviation itself, not a score out of anything:
there is no natural maximum for how wildly someone can run, so any ceiling would be
invented, and capping at one would hide the difference between a wild player and a very
wild player. It's withheld below three sessions, where a deviation is noise rather than
a read.

Both read the `session_results` view (added by `chips-schema.sql`); a database that
predates it still renders the board, just without the chart and chaos tab.

### Leaderboard: all-ins

The all-ins tab is a plain lifetime tally: every bet, raise or call that left a player
with nothing behind, summed over every game they have ever played. Not a rate, not a
per-session average — the number on the row is the count itself.

Blind posts that swallowed a short stack are flagged in the ledger but **not** counted:
being too short to cover a blind isn't a decision, and counting it would just re-rank the
column by who plays down to the felt most often — which is what `times last` already says.

All-ins are **recorded, not reconstructed**. `events.all_in` is set by the app on the
action that emptied the stack, because that is the one moment the stack is known for
certain. Replaying the ledger to find the same thing would need the replayed stack to land
on exactly zero, and `session-audit.sql` exists precisely because those totals sometimes
drift — one chip out and an all-in silently reads as an ordinary bet.

The consequence is that the counts only cover sessions played after the migration:

```sql
alter table events add column all_in boolean not null default false;
create index events_all_in_player_idx on events (player_id) where all_in;
```

then re-run the `lifetime_stats` block of `chips-schema.sql` to pick up the `all_ins`
column. Until those are run the tab renders with zeroes rather than failing.

### Extended player stats

`supabase/player-stats.sql` gives you `player_stats` with the poker-jargon numbers
the leaderboard has no room for: VPIP, PFR and the gap between them, aggression
factor, flop c-bet and fold-to-c-bet, steal attempts and fold-to-steal, WTSD, and a
VPIP split by position. Run it once, after `chips-schema.sql`.

It arrives as two objects. `player_stats_source` is the query that derives the
numbers; `player_stats` is a **materialized** snapshot of it, refreshed by
`refresh_player_stats()` when a session ends. That is not premature optimisation —
read directly, the source query cannot be planned: the planner estimates its first
stage at ~13 rows when it returns thousands, picks nested loops all the way up, and
takes over two minutes on a ledger that each stage handles in milliseconds. Against
Supabase's 3-second statement limit every query failed, `limit 1` included. The full
diagnosis is in the file. Read `player_stats`; never point the app at the source.

The interesting part is that **position is reconstructed, not recorded**. The app
only ever stores the *current* button, so there is no per-hand history of who sat
where. But every hand posts blinds, and `post_sb` / `post_bb` name those players —
combined with `seat_order` that pins the whole ring. Preflop this is exact rather
than approximate, because action passes in seat order and everyone dealt in either
posts a blind or gets a turn to act.

Two things follow, and the file explains both at length:

- At 3-handed there is no cutoff, so short-handed sessions contribute nothing to the
  CO columns rather than contributing something wrong.
- Every percentage ships with its denominator (`cbet_opps`, `steal_opps`, …) and a
  blunt `reliability` column, because a steal percentage off three opportunities is
  an anecdote. Filter on the counts before quoting anything.

### Profiles, coaching, and session recaps

The profiles tab lists everyone with a generated one-or-two-line profile beneath
their name, ordered by hands played. Tap your own row and it expands to coaching
("what to work on", visible only on your own device) above your full stat
breakdown. When a session ends, the game-over screen streams a short recap of it.

All three are written by Claude Opus 5 from `api/_prompts.js`, which is the single
source: the prompt lab reads the same file, so a variant is always compared against
what is actually live.

The interesting part is what *doesn't* happen. Most sessions cost nothing:
`api/profile.js` compares each player's figures against the snapshot their existing
text was written from and returns without calling the model unless someone has
moved past a threshold. A profile that rewrote itself every session would carry no
weight, so the ones that do change mean something. When a call is warranted, the
whole table goes in one request with only the drifted players named for rewriting,
because the best lines are comparisons and those need everyone in view.

Identity flows on an opaque key, not a display name. This app ships a merge tool
precisely because one person can appear as several identities, and those duplicates
share a name — keyed by name, one person's profile can land on another's row.

The recap is the only endpoint a browser can reach, so it cannot hold a secret. It
will only write about a session that exists, has ended, has at least 2 players and
5 dealt hands, and has no recap yet; that last condition caps spend at one
generation per session, ever. Runs about 2 seconds to first token.

Those checks are worth being honest about, though: the chips tables are
anon-writable by design and the publishable key is in the browser bundle, so
someone determined could fabricate a session that satisfies all of them. Both
endpoints therefore also carry a flat daily ceiling — 20 recaps and 60 profiles
across everyone, roughly twenty times normal use — and the real backstop is a spend
limit set on the Anthropic workspace, which lives outside this repo. CLAUDE.md has
the full picture, including how to make the two generated-text tables read-only to
the browser.

Setup lives outside this repo: `ANTHROPIC_API_KEY` and `PROFILE_SECRET` in Vercel,
a Supabase webhook on `sessions` UPDATE pointing at `/api/profile`, and the
`player-profiles.sql` / `session-recaps.sql` migrations. See CLAUDE.md.

### Tuning the prompts

`scripts/prompt-lab/` holds an offline harness. The quick loop needs no setup:

    npm run lab:table

prints the live stats as a markdown table to paste into an ordinary Claude chat.
That is how the current profile prompt was found, and it beats a harness for
finding the voice. `npm run lab` is for the later job of comparing candidates
properly: it runs each variant twice against identical input, so a real
improvement can be told apart from a lucky generation, and it can run the same
prompt across models.

### Exporting the data for player analytics

`supabase/analytics-export.sql` pulls the whole history out in analysis-ready
shapes — a player-per-session fact table, the denormalized event ledger,
playing-style stats (VPIP, PFR, aggression factor) that the leaderboard has no
room for, running-total trend lines, and head-to-head records. Each block runs
in the Supabase SQL editor and downloads as CSV; the header explains the psql
`\copy` / `pg_dump` route for bigger pulls. Run the data-quality sweep at the
bottom first — duplicate identities and unended sessions skew everything above
it.
