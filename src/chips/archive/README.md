# Frozen series boards

One JSON file per **ended** series, written by `scripts/end-series.mjs` and
committed. Each is the exact input its leaderboard was rendering on the last day
of play, so `src/pages/chips/[series]/leaderboard.astro` can prerender that board
as static HTML — no database behind it, forever.

This is what makes ending a series safe to do at all: the board outlives the rows
it was computed from. Nothing here is generated at build time from Supabase, and
nothing here should be edited by hand.

`coaching` is deliberately absent. It is written to be read by the player it is
about, and this directory is a public repository; the frozen board renders
profiles and the detailed stats panel without it. The full ledger, coaching
included, goes to the gitignored `backups/` dump instead — see the runbook in
README.md.
