# keogan.ca4
updated version of personal website

## /chips

A poker-night chip tracker (ported from the standalone poker-tracker project),
living at `keogan.ca/chips`. Unlinked from the main site and excluded from the
sitemap. The Svelte app lives in `src/chips/` (components + game logic) with
Astro pages in `src/pages/chips/`; the invite routes (`/chips/WOLF` etc.) are
prerendered from the fixed 15-word join-code pool.

It uses the same Supabase project as the guestbook (via the existing
`PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_ANON_KEY` env vars — no extra
config). One-time setup: run `supabase/chips-schema.sql` in that project's
SQL editor. It creates the game tables, the `lifetime_stats` view, open anon
RLS policies, the required Data API grants, and enables realtime on
`sessions`, `players`, and `events`.

### When a night's numbers look wrong

`supabase/session-audit.sql` backtracks a session from its `session_id`:
find the right session (join codes are reused, so a night can split across
two), check that chips balance
(`sum(stack) + pot == sum(total_buyin)`), then walk the `events` ledger to
find the hand where they stopped balancing. Paste one block at a time into
the Supabase SQL editor.

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

The chaos tab ranks players by the standard deviation of their per-session results,
measured in **big blinds** — raw chips would mostly rank people by which stakes they
turned up for. The figure shown is that deviation itself, not a score out of anything:
there is no natural maximum for how wildly someone can run, so any ceiling would be
invented, and capping at one would hide the difference between a wild player and a very
wild player. It's withheld below three sessions, where a deviation is noise rather than
a read.

Both read the `session_results` view (added by `chips-schema.sql`); a database that
predates it still renders the board, just without the chart and chaos tab.

### Extended player stats

`supabase/player-stats.sql` creates a `player_stats` view with the poker-jargon
numbers the leaderboard has no room for: VPIP, PFR and the gap between them,
aggression factor, flop c-bet and fold-to-c-bet, steal attempts and fold-to-steal,
WTSD, and a VPIP split by position. Run it once, after `chips-schema.sql`.

The interesting part is that **position is reconstructed, not recorded**. The app
only ever stores the *current* button, so there is no per-hand history of who sat
where. But every hand posts blinds, and `post_sb` / `post_bb` name those players —
combined with `seat_order` that pins the whole ring. Preflop this is exact rather
than approximate, because action passes in seat order and everyone dealt in either
posts a blind or gets a turn to act.

Two things follow, and the file explains both at length:

- At 3-handed there is no cutoff, so short-handed nights contribute nothing to the
  CO columns rather than contributing something wrong.
- Every percentage ships with its denominator (`cbet_opps`, `steal_opps`, …) and a
  blunt `reliability` column, because a steal percentage off three opportunities is
  an anecdote. Filter on the counts before quoting anything.

### Exporting the data for player analytics

`supabase/analytics-export.sql` pulls the whole history out in analysis-ready
shapes — a player-per-night fact table, the denormalized event ledger,
playing-style stats (VPIP, PFR, aggression factor) that the leaderboard has no
room for, running-total trend lines, and head-to-head records. Each block runs
in the Supabase SQL editor and downloads as CSV; the header explains the psql
`\copy` / `pg_dump` route for bigger pulls. Run the data-quality sweep at the
bottom first — duplicate identities and unended sessions skew everything above
it.
