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
thing that scales past a handful of players.

Two rules worth knowing before editing it:

- **Colour follows the player, never their rank.** Slots are handed out in debut
  order, so a colour is stable for good. Rank-ordered colour would repaint the whole
  chart after every session and nobody could follow their own line across two visits.
- **The palette's slot order is a colourblind-safety guarantee**, validated against
  the chips paper. Don't reorder or hand-pick a replacement without re-validating.
  See the header of `src/styles/chips.css`.

The chaos tab ranks players by the standard deviation of their per-night result,
measured in **big blinds** — raw chips would mostly rank people by which stakes they
turned up for. It's scored out of 100 against the wildest player in the group, and
withheld entirely below three sessions, where a standard deviation is noise.

Both read the `session_results` view (added by `chips-schema.sql`); a database that
predates it still renders the board, just without the chart and chaos tab.

### Exporting the data for player analytics

`supabase/analytics-export.sql` pulls the whole history out in analysis-ready
shapes — a player-per-night fact table, the denormalized event ledger,
playing-style stats (VPIP, PFR, aggression factor) that the leaderboard has no
room for, running-total trend lines, and head-to-head records. Each block runs
in the Supabase SQL editor and downloads as CSV; the header explains the psql
`\copy` / `pg_dump` route for bigger pulls. Run the data-quality sweep at the
bottom first — duplicate identities and unended sessions skew everything above
it.
