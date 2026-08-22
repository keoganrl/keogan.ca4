# prompt lab

Offline harness for tuning the profile / coaching / recap prompts against real
data, without deploying anything or touching the live site.

## Setup

    cp .env.local.example .env.local

Fill in the three values it asks for. `.env.local` is gitignored.

## Pull your real data, once

    npm run lab:pull

Reads your live Supabase and writes `fixtures/players.json` with **anonymised**
names (Player A, Player B…). Add `-- --real-names` to keep them; that file is
gitignored, the anonymised one is safe to commit.

Pull once and reuse it. If every run re-queries Supabase the data drifts under
you, and you can no longer tell whether a better output came from a better
prompt or a different night. Re-run it whenever you want fresher numbers.

## Run

    npm run lab                        # profiles, both variants, 2 reps
    npm run lab -- --kind coaching     # the coaching prompts instead
    npm run lab -- --model claude-opus-5
    npm run lab -- --players 3         # keep it cheap while finding the shape
    npm run lab -- --reps 3            # when two variants look close

Everything after `--` is passed through. Results land in `out/<timestamp>.html` —
open it in a browser and read the variants side by side.

## Why two reps

Same prompt, same input, two calls. If one variant's two outputs differ in
quality more than two variants differ from each other, you are reading noise,
not a prompt difference. It costs pennies and stops you shipping a prompt that
got lucky once. This matters more than usual on Fable 5, which rejects
`temperature` outright — there is no knob to steady the output with.

## Running this from a Claude Code session

The lab can be driven entirely by Claude rather than by hand, so nobody has to
run commands locally. Two things have to be true of the session's environment
(both set in the environment's settings at claude.ai/code, not in this repo):

- `ANTHROPIC_API_KEY`, `PUBLIC_SUPABASE_URL`, and `PUBLIC_SUPABASE_ANON_KEY` are
  set as environment variables. They reach the container directly and never pass
  through the conversation — which is the point: an API key pasted into a message
  is stored in the transcript, and the right fix for one that was is to revoke it.
- The network policy allows `<project>.supabase.co`. The default policy blocks it,
  and `api.anthropic.com` is allowed by default, so generation works before
  pulling does. A blocked pull looks like curl returning 000, not an auth error.

Both are applied when a container starts, so a change to either needs a fresh
session. With them in place the whole loop is `npm run lab:pull` once, then
`npm run lab` per iteration, with the resulting HTML sent back to the user.

## How a prompt is assembled

Two layers, like a personalisation setting plus a task instruction:

    prompts/_shared.md        the house prompt — sent with every kind
    prompts/<kind>-<name>.md  the task prompt — one per variant

They are concatenated in that order and sent as one system prompt. Put anything
true of all three features in `_shared.md` (who the audience is, the never-invent
rule, the small-sample rule); put the actual job in the variant. Where the two
overlap the variant wins, because it comes second.

`_shared.md` is not a variant and never becomes a column — files starting with
`_` are skipped.

`{{STATS}}` is replaced with that player's JSON, in whichever layer it appears.
