// Daily cron (see vercel.json). Two jobs, in this order and for this reason:
//
//  1. Ping Supabase so the free-tier project does not pause. LOAD-BEARING — if this
//     stops, the database eventually pauses and the guestbook, /chips and notify all
//     go down together (see CLAUDE.md).
//  2. Delete single sessions older than five days.
//
// The ping runs first and unchanged, and its result is what decides the status code.
// The purge is the newer, riskier half; it must never be able to take the keep-alive
// down with it, so its failures are reported in the body rather than thrown.
import { db, json } from './_supabase.js';
import { cutoffFrom, selectForPurge, RETENTION_DAYS, MAX_PER_RUN } from './_purge.js';

/**
 * Deletes single sessions that have aged out. Returns what it did, and never throws.
 *
 * ############################################################################
 * This is one of only two places in the repo allowed to delete /chips data (the
 * other is scripts/end-series.mjs). Read api/_purge.js before changing it.
 *
 * players, rebuys, hands, events and session_recaps all declare ON DELETE CASCADE
 * on sessions, so each id below takes that session's entire ledger with it — every
 * blind, bet, call and fold. There is no undo and no soft delete.
 *
 * Two rules hold it together:
 *   * it deletes by explicit id list, never by filter. A filter on a DELETE that
 *     loses a parameter in transit matches every session ever played; a list of
 *     ids cannot mean anything other than those ids.
 *   * it refuses rather than corrects. Anything unexpected — a row that does not
 *     match the predicate, a set larger than MAX_PER_RUN, a cutoff in the future —
 *     deletes nothing and reports why.
 * ############################################################################
 *
 * Gated on PURGE_ENABLED. Unset, it reports exactly what it WOULD delete and stops
 * there, which is how it ships: the point is to read a week of cron logs and confirm
 * the ids really are throwaway one-off sessions before anything is removed.
 */
async function purgeSingleSessions() {
  const enabled = process.env.PURGE_ENABLED === '1';
  const cutoff = cutoffFrom();

  let rows;
  try {
    rows = await json(
      `sessions?select=id,created_at,series_id` +
        `&series_id=is.null&created_at=lt.${cutoff.toISOString()}`
    );
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const decision = selectForPurge(rows ?? [], cutoff);
  if (!decision.ok) {
    return { ok: false, refused: decision.reason, ...decision };
  }
  if (decision.ids.length === 0) {
    return { ok: true, enabled, candidates: 0, purged: 0 };
  }

  // Report-only until someone has read these ids and agreed with them.
  if (!enabled) {
    return {
      ok: true,
      enabled: false,
      wouldPurge: decision.ids.length,
      ids: decision.ids,
      olderThan: `${RETENTION_DAYS} days`,
    };
  }

  try {
    // By id, never by filter. See the block comment above.
    const r = await db(`sessions?id=in.(${decision.ids.join(',')})`, { method: 'DELETE' });
    if (!r.ok) {
      return { ok: false, error: `delete failed: ${r.status} ${await r.text()}` };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }

  return { ok: true, enabled: true, purged: decision.ids.length, ids: decision.ids };
}

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // The ping, first and unchanged. Deliberately still the publishable key and a bare
  // fetch: the one thing this endpoint must always do should not depend on anything
  // that was added to it later.
  const r = await fetch(
    `${process.env.PUBLIC_SUPABASE_URL}/rest/v1/guestbook_entries?select=id&limit=1`,
    { headers: { apikey: process.env.PUBLIC_SUPABASE_ANON_KEY } }
  );
  if (!r.ok) return res.status(500).json({ ok: false, status: r.status });

  // A purge that fails is worth seeing in the logs, but it is not worth failing the
  // keep-alive over: the database was reached, which is the job that matters.
  const purge = await purgeSingleSessions();

  return res.status(200).json({
    ok: true,
    pinged: new Date().toISOString(),
    purge,
    maxPerRun: MAX_PER_RUN,
  });
}
