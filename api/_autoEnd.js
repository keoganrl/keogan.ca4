// Deciding which abandoned sessions close themselves, and what they owe.
//
// Split out from api/keep-alive.js so both halves are testable without a database:
// which sessions have gone quiet, and how the chips still on the felt get handed
// back. Same posture as api/_purge.js — an unexpected row refuses the whole run
// rather than being quietly corrected.
//
// The problem this exists for: nothing made a session end except somebody tapping
// "End session", and the leaderboard only counts sessions with status 'ended'. A
// game everyone walked away from stayed 'active' forever and contributed nothing —
// not to the board, not to anyone's stats. DW-2026-07 was carrying two of these
// (five players each, played in July, never ended) and they were invisible until
// the series was archived and somebody counted the rows.

/** How long a session may sit with nothing happening before it closes itself. */
export const IDLE_HOURS = 18;

/**
 * Most sessions one run may close.
 *
 * A normal run closes none or one. A run that wants to close a dozen means the
 * clock or the predicate is wrong, not that a dozen games were abandoned at once,
 * so it stops and puts the ids in the cron log instead.
 */
export const MAX_PER_RUN = 20;

/** Statuses that represent a game that was actually started and never finished. */
export const OPEN_STATUSES = ['active', 'paused'];

/** The moment before which a session's last sign of life counts as abandoned. */
export function cutoffFrom(now = Date.now()) {
  return new Date(now - IDLE_HOURS * 60 * 60 * 1000);
}

/**
 * Decides which of the open sessions have gone quiet long enough to close.
 *
 * `rows` are `{ id, status, lastActivity }`, where lastActivity is the timestamp of
 * the session's most recent LEDGER EVENT, falling back to when it was created if no
 * hand was ever dealt.
 *
 * The last event is the clock rather than players.last_heartbeat_at, and that choice
 * is the whole point of the feature. A heartbeat says a browser tab is open, which a
 * forgotten laptop on the kitchen table will keep saying indefinitely — exactly the
 * session this is supposed to close. An event says somebody bet, called, folded or
 * dealt. Eighteen hours without one of those means the game is over whatever the
 * tabs think.
 *
 * Returns { ok: true, ids } or { ok: false, reason, ... }.
 */
export function selectForAutoEnd(rows, cutoff) {
  const now = Date.now();
  if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) {
    return { ok: false, reason: 'cutoff is not a date' };
  }
  // A cutoff in the future would sweep up games being played right now.
  if (cutoff.getTime() > now) {
    return { ok: false, reason: 'cutoff is in the future' };
  }

  if (!Array.isArray(rows)) return { ok: false, reason: 'no candidate list' };
  if (rows.length === 0) return { ok: true, ids: [] };

  // Re-assert the predicate on what came back. The status filter travels as a query
  // string, and a dropped parameter does not error — it just widens the result to
  // every session in the table, ended ones included.
  const wrong = rows.filter(
    (r) =>
      !r?.id ||
      !OPEN_STATUSES.includes(r.status) ||
      !(Date.parse(r.lastActivity) < cutoff.getTime())
  );
  if (wrong.length > 0) {
    return {
      ok: false,
      reason: 'candidate rows do not match the filter',
      offending: wrong.slice(0, 5).map((r) => r?.id ?? '(no id)'),
    };
  }

  if (rows.length > MAX_PER_RUN) {
    return { ok: false, reason: `more than ${MAX_PER_RUN} candidates`, count: rows.length };
  }

  return { ok: true, ids: rows.map((r) => r.id) };
}

/**
 * Works out what each player gets back when the books close on an abandoned session.
 *
 * ############################################################################
 * This is a SECOND implementation of the refund rule in `endSession`
 * (src/chips/lib/services/table.ts). The two must agree. If you change one,
 * change the other, and read that function's comment first — it records a live
 * chip bug (2026-08-14: a 9000-chip session cashed out at 12290) that the rule
 * below is shaped to avoid.
 * ############################################################################
 *
 * The rule, and why it is not simply "refund what everyone bet":
 *
 * The leaderboard reads net as stack − buy-in, so chips left on the felt would score
 * as permanent losses for whoever bet them. But `pot` — not hand_total_bet — is what
 * is actually owed. hand_total_bet is only cleared by the next deal, so after a hand
 * plays to showdown it still holds everyone's commitment even though the winners have
 * already been paid that exact sum. Refunding it there pays the last hand twice.
 *
 * So the pot is the ceiling: pot == 0 means the hand was awarded and nothing is owed;
 * pot > 0 means it was abandoned mid-hand and those chips go back. Largest
 * contributors first, because they hold the side-pot equity. However it splits, the
 * total handed back is exactly the pot, so chips are conserved either way.
 *
 * Inactive players are included: somebody who left mid-hand keeps their
 * hand_total_bet, and their net has to come out right too.
 *
 * Returns one entry per player needing a write, each with the ABSOLUTE new stack.
 */
export function planRefunds(players, pot) {
  let remaining = Math.max(0, pot ?? 0);

  return (players ?? [])
    .filter((p) => p.hand_total_bet > 0 || p.current_round_bet > 0)
    .sort((a, b) => b.hand_total_bet - a.hand_total_bet)
    .map((p) => {
      const refund = Math.min(p.hand_total_bet, remaining);
      remaining -= refund;
      // Both bet columns are cleared whether or not there was anything to refund, so
      // an ended session never leaves a stale commitment to be mistaken for chips owed.
      return { id: p.id, refund, stack: p.stack + refund };
    });
}
