// Daily cron (see vercel.json). Three jobs, in this order and for this reason:
//
//  1. Ping Supabase so the free-tier project does not pause. LOAD-BEARING — if this
//     stops, the database eventually pauses and the guestbook, /chips and notify all
//     go down together (see CLAUDE.md).
//  2. Close sessions nobody ended, 18 hours after the last thing happened in them.
//  3. Delete single sessions older than five days.
//
// The ping runs first and unchanged, and its result is what decides the status code.
// The other two are the newer, riskier halves; neither may take the keep-alive down
// with it, so their failures are reported in the body rather than thrown.
//
// Two before three on purpose: a session that closes itself should reach the
// leaderboard and get its final results before it is ever eligible to be deleted.
import { db, json, jsonAll } from './_supabase.js';
import { cutoffFrom, selectForPurge, RETENTION_DAYS, MAX_PER_RUN } from './_purge.js';
import {
  cutoffFrom as autoEndCutoff,
  selectForAutoEnd,
  planRefunds,
  IDLE_HOURS,
  OPEN_STATUSES,
} from './_autoEnd.js';

/**
 * Closes sessions nobody ended. Returns what it did, and never throws.
 *
 * Ending a session is NOT just flipping a status — see planRefunds in
 * api/_autoEnd.js and endSession in src/chips/lib/services/table.ts. Chips still on
 * the felt have to be handed back first, or the leaderboard scores them as permanent
 * losses for whoever bet them.
 *
 * The close is a compare-and-swap (`status=neq.ended`) for the same reason the
 * client's is: the host can tap "End session" at the same moment this cron fires,
 * and both would otherwise compute a refund from the same pot and hand the felt back
 * twice. Whoever wins the swap owns the refund; the loser sees no row and writes
 * nothing.
 *
 * Sessions are closed one at a time rather than in a batch, because each one's
 * refunds are computed from its own pot. One failing is logged and the rest carry on.
 */
async function autoEndStaleSessions() {
  const cutoff = autoEndCutoff();

  let open;
  try {
    open = await jsonAll(
      `sessions?select=id,join_code,status,created_at` +
        `&status=in.(${OPEN_STATUSES.join(',')})&order=id`
    );
  } catch (e) {
    return { ok: false, error: e.message };
  }

  // The clock is the last LEDGER EVENT, not the last heartbeat — a forgotten open tab
  // keeps heartbeats coming forever, and that is precisely the session this closes.
  // One small query each; the candidate set is a handful of rows in practice.
  const candidates = [];
  for (const s of open ?? []) {
    try {
      // Ordered by seq, which is what events_session_seq_idx is built on.
      const [last] = await json(
        `events?select=created_at&session_id=eq.${s.id}&order=seq.desc&limit=1`
      );
      candidates.push({ ...s, lastActivity: last?.created_at ?? s.created_at });
    } catch (e) {
      return { ok: false, error: `reading events for ${s.id}: ${e.message}` };
    }
  }

  const stale = candidates.filter((c) => Date.parse(c.lastActivity) < cutoff.getTime());
  const decision = selectForAutoEnd(stale, cutoff);
  if (!decision.ok) return { ok: false, refused: decision.reason, ...decision };
  if (decision.ids.length === 0) {
    return { ok: true, open: candidates.length, ended: 0, idleHours: IDLE_HOURS };
  }

  const ended = [];
  const failed = [];
  for (const id of decision.ids) {
    try {
      // Read the pot and the seats BEFORE closing, exactly as endSession does: these
      // become absolute stack writes, so they must not come from anything stale.
      const [players, [session]] = await Promise.all([
        jsonAll(`players?select=*&session_id=eq.${id}&order=id`),
        json(`sessions?select=pot&id=eq.${id}`),
      ]);

      const closed = await db(`sessions?id=eq.${id}&status=neq.ended`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: 'ended', pot: 0, current_bet: 0 }),
      });
      if (!closed.ok) {
        failed.push({ id, error: `${closed.status} ${await closed.text()}` });
        continue;
      }
      // Lost the swap: somebody ended it between the read and here. Write nothing.
      if (!(await closed.json())?.length) continue;

      for (const r of planRefunds(players, session?.pot)) {
        await json(`players?id=eq.${r.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            stack: r.stack,
            hand_total_bet: 0,
            current_round_bet: 0,
          }),
        });
      }
      ended.push(id);
    } catch (e) {
      failed.push({ id, error: e.message });
    }
  }

  // player_stats is a snapshot scoped to ended sessions, so closing one changes its
  // inputs. api/profile.js refreshes it too when the webhook fires, but that only
  // covers series sessions and only if the webhook is configured.
  if (ended.length > 0) {
    try {
      await json('rpc/refresh_player_stats', { method: 'POST', body: '{}' });
    } catch (e) {
      return { ok: true, ended: ended.length, ids: ended, failed, refreshError: e.message };
    }
  }

  return {
    ok: failed.length === 0,
    open: candidates.length,
    ended: ended.length,
    ids: ended,
    idleHours: IDLE_HOURS,
    ...(failed.length ? { failed } : {}),
  };
}

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

  // Neither of these is worth failing the keep-alive over: the database was reached,
  // which is the job that matters. Failures go in the body for the cron log instead.
  //
  // Auto-end before purge, so a session that closes itself lands on the leaderboard
  // before it is ever old enough to be deleted.
  const autoEnd = await autoEndStaleSessions();
  const purge = await purgeSingleSessions();

  return res.status(200).json({
    ok: true,
    pinged: new Date().toISOString(),
    autoEnd,
    purge,
    maxPerRun: MAX_PER_RUN,
  });
}
