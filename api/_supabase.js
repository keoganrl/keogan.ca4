// Shared Supabase access for the serverless functions. Both endpoints reached for
// the same two helpers and had identical copies of them.
//
// Reads process.env, not import.meta.env: these are native Vercel functions, not
// Astro routes (see CLAUDE.md).

export const db = (path, init = {}) =>
  fetch(`${process.env.PUBLIC_SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: process.env.PUBLIC_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${process.env.PUBLIC_SUPABASE_ANON_KEY}`,
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

/** Row count from a PostgREST exact-count response, e.g. "0-0/12" -> 12. */
export async function countOf(path) {
  const r = await db(`${path}&select=id&limit=1`, { headers: { Prefer: 'count=exact' } });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return Number(r.headers.get('content-range')?.split('/')[1] ?? 0);
}
