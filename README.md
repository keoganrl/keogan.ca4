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

### The button when somebody leaves

The button does **not** move when a player stands up mid-hand. It stays on their empty
seat as a *dead button* until the next deal, exactly as it would at a real table, and
`endHand` then rotates off that seat. Rotating at the moment somebody left was the old
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
per-night average — the number on the row is the count itself.

Blind posts that swallowed a short stack are flagged in the ledger but **not** counted:
being too short to cover a blind isn't a decision, and counting it would just re-rank the
column by who plays down to the felt most often — which is what `times last` already says.

All-ins are **recorded, not reconstructed**. `events.all_in` is set by the app on the
action that emptied the stack, because that is the one moment the stack is known for
certain. Replaying the ledger to find the same thing would need the replayed stack to land
on exactly zero, and `session-audit.sql` exists precisely because those totals sometimes
drift — one chip out and an all-in silently reads as an ordinary bet.

The consequence is that the counts only cover nights played after the migration:

```sql
alter table events add column all_in boolean not null default false;
create index events_all_in_player_idx on events (player_id) where all_in;
```

then re-run the `lifetime_stats` block of `chips-schema.sql` to pick up the `all_ins`
column. Until those are run the tab renders with zeroes rather than failing.

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

### Free-tier headroom

`supabase/free-tier-usage.sql` measures the project against Supabase's free
plan. Disk is not the constraint — a night is ~100 KB of rows, so 500 MB holds
thousands of them. **Realtime messages are**, and they scale with the square of
the table size.

Every phone subscribes to `postgres_changes` on `sessions`, `players` and
`events`, and messages are billed per delivery, so one row change at an N-seat
table is N messages. The dominant writer isn't gameplay: each client UPDATEs
its own `players` row every 10s as a presence heartbeat, and `players` is in
the realtime publication, so heartbeats alone cost `6N²` messages a minute —
about 75% of all traffic, and ~52k of a six-handed four-hour night's ~56k
messages. Against the 2M/month quota that's roughly 35 six-handed nights a
month, or 13 ten-handed ones.

So the thing to ration is seats × hours, not the invite list. If the month gets
tight, fix the heartbeat before restricting who can play: move
`last_heartbeat_at` to a table outside the publication (its only reader is the
stale-host check), or raise the interval — the saving is linear in it.

Blocks 0-2 are exact; 4-6 are estimates, since realtime and egress are metered
by the platform and aren't visible from SQL. The dashboard (Project Settings →
Usage, Reports → Realtime) is the ground truth to check them against.
