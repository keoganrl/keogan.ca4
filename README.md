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
