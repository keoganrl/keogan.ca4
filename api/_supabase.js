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
 * Every row matching `path`, following PostgREST's pagination to the end.
 *
 * A plain GET stops at the server's row cap — 1000 by default — and says nothing
 * about it. A truncated response is shaped exactly like a complete small one, so
 * nothing downstream can tell the difference. The first run of
 * scripts/end-series.mjs wrote a "full" backup of DW-2026-07 containing 1000 of its
 * 4947 events, and the only thing that gave it away was that 1000 is a suspiciously
 * round number. Anything that must be COMPLETE — above all a backup taken before a
 * delete — has to come through here rather than through json().
 *
 * `path` MUST carry an `order=` clause, and it is rejected rather than defaulted.
 * Paging an unordered query is the same bug wearing a better disguise: without a
 * total order the server may return pages that overlap or skip rows, so the result
 * is silently wrong instead of silently short. The right column differs per table
 * (session_recaps has no `id` at all), so only the caller can choose it.
 *
 * Pages advance by the number of rows actually returned, not by `pageSize`, so a
 * server whose cap is lower than the page asked for still paginates correctly
 * instead of stopping after one short page.
 */
export async function jsonAll(path, pageSize = 1000) {
  if (!/[?&]order=/.test(path)) {
    throw new Error(`jsonAll needs an order= clause for stable paging: ${path}`);
  }

  const rows = [];
  for (let offset = 0, page = 0; ; page++) {
    // A server that ignored `offset` would loop forever handing back page one.
    // Failing loudly beats filling memory with the same thousand rows.
    if (page > 500) throw new Error(`jsonAll: refusing to page past ${offset} rows: ${path}`);

    const batch = await json(`${path}&limit=${pageSize}&offset=${offset}`);
    if (!batch?.length) return rows;
    rows.push(...batch);
    offset += batch.length;
  }
}

/**
 * Row count from a PostgREST exact-count response, e.g. "0-0/12" -> 12.
 *
 * Unlike a bare GET this is never capped: the total comes from the Content-Range
 * header rather than from the number of rows in the body.
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
