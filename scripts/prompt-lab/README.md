# prompt lab

Offline harness for tuning the profile / coaching / recap prompts against real
data, without deploying anything or touching the live site.

## Setup

`@anthropic-ai/sdk` is already a devDependency — `npm install` is enough.

Put credentials in `.env.local` at the repo root (gitignored):

    ANTHROPIC_API_KEY=sk-ant-...
    PUBLIC_SUPABASE_URL=https://....supabase.co
    PUBLIC_SUPABASE_ANON_KEY=...

## Pull a fixture, once

    node --env-file=.env.local scripts/prompt-lab/pull.js

Writes `fixtures/players.json` with **anonymised** names (Player A, Player B…).
Pass `--real-names` to keep them. The anonymised file is safe to commit; a real
one is not, and `.gitignore` blocks it.

Pull once and reuse it. If every run re-queries Supabase the data drifts under
you, and you can no longer tell whether a better output came from a better
prompt or a different night.

## Run

    node --env-file=.env.local scripts/prompt-lab/run.js

    --kind profile|coaching     which prompt folder to run (default: profile)
    --model claude-fable-5      any model id (default: claude-fable-5)
    --reps 2                    generations per variant (default: 2)
    --players 4                 how many fixture players to run (default: all)

Every `prompts/<kind>-*.md` file is a variant; all of them run against the same
players. Results land in `out/<timestamp>.html` — open it in a browser and read
the variants side by side.

## Why two reps

Same prompt, same input, two calls. If one variant's two outputs differ in
quality more than two variants differ from each other, you are reading noise,
not a prompt difference. It costs pennies and stops you shipping a prompt that
got lucky once. This matters more than usual on Fable 5, which rejects
`temperature` outright — there is no knob to steady the output with.

## Writing a variant

A prompt file is plain markdown. `{{STATS}}` is replaced with that player's
JSON. Everything else is sent as the system prompt verbatim.
