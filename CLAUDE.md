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
