// Shared Supabase access for the serverless functions. Both endpoints reached for
// the same two helpers and had identical copies of them.
//
// Reads process.env, not import.meta.env: these are native Vercel functions, not
// Astro routes (see CLAUDE.md).

// SUPABASE_SERVICE_ROLE_KEY when it is set, the publishable key otherwise.
//
// Everything these functions do works on the publishable key, because the chips
// tables are anon-writable by design. The service role exists so that the two
// GENERATED-TEXT tables need not be: with it set, the anon write grants on
// player_profiles and session_recaps can be revoked (see
// supabase/lock-down-generated-text.sql) and the only thing that can write a
// profile or a recap is this code. Unset, nothing changes and nothing breaks.
const key = () =>
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.PUBLIC_SUPABASE_ANON_KEY;

export const db = (path, init = {}) =>
  fetch(`${process.env.PUBLIC_SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key(),
      Authorization: `Bearer ${key()}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });

/**
 * Same as db(), but throws on a non-2xx and returns the parsed body.
 *
 * The body is read as TEXT first because PostgREST answers a write with 201 and an
 * empty body unless asked for a representation, and .json() on empty input throws
 * "Unexpected end of JSON input" — which reads like a model failure when the write
 * in fact succeeded. That cost a live debugging round.
 */
export async function json(path, init) {
  const r = await db(path, init);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  const body = await r.text();
  return body ? JSON.parse(body) : null;
}

/**
 * Row count from a PostgREST exact-count response, e.g. "0-0/12" -> 12.
 *
 * `column` is only there to keep the response body to one small column; it must be a
 * column the table actually has, which is why it is a parameter — session_recaps is
 * keyed on session_id and has no id at all.
 */
export async function countOf(path, column = 'id') {
  const r = await db(`${path}&select=${column}&limit=1`, {
    headers: { Prefer: 'count=exact' },
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return Number(r.headers.get('content-range')?.split('/')[1] ?? 0);
}
