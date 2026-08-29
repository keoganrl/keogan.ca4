// Deciding what the five-day purge may delete.
//
// Split out from api/keep-alive.js so the decision is testable without a database.
// Every guard here is deliberately a REFUSAL rather than a correction: if the set of
// candidates is not exactly what was asked for, the right move is to delete nothing
// and say so, because the alternative is deleting rows nobody meant to lose. There is
// no undo — players, rebuys, hands, events and session_recaps all cascade from
// sessions, so one wrong id takes a whole night's ledger with it.

/** A session is a candidate five days after it was created. */
export const RETENTION_DAYS = 5;

/**
 * Most sessions one run may delete.
 *
 * The group plays a few times a month, so a normal run has none or one. Anything
 * near this number means the predicate is wrong, not that there was a lot to clean
 * up — so it aborts rather than proceeding, and the count goes in the cron log.
 */
export const MAX_PER_RUN = 50;

/**
 * The moment before which a single session is old enough to delete.
 *
 * created_at is the right clock for both shapes this has to cover. A session is
 * created and ended the same evening, so for a played night it is the night; and a
 * game abandoned at the setup screen never gets any later timestamp at all.
 */
export function cutoffFrom(now = Date.now()) {
  return new Date(now - RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Checks the rows PostgREST returned actually match what was asked for, and returns
 * the ids to delete — or refuses.
 *
 * The re-check is not paranoia about Postgres. It is about the REQUEST: the filter
 * travels as a query string, and a dropped or mistyped parameter does not error, it
 * just widens the result. `series_id=is.null` lost in transit returns every session
 * ever played, and every one of them looks like a perfectly good row. Re-asserting
 * the predicate here is the only place that difference is visible before the delete.
 *
 * Returns { ok: true, ids } or { ok: false, reason, ... }.
 */
export function selectForPurge(rows, cutoff) {
  // A cutoff in the future would match everything. Cheap to check, and the failure
  // it guards against — a clock or an arithmetic slip — is total.
  const now = Date.now();
  if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) {
    return { ok: false, reason: 'cutoff is not a date' };
  }
  if (cutoff.getTime() > now) {
    return { ok: false, reason: 'cutoff is in the future' };
  }

  if (!Array.isArray(rows)) return { ok: false, reason: 'no candidate list' };
  if (rows.length === 0) return { ok: true, ids: [] };

  const wrong = rows.filter(
    (r) =>
      !r?.id ||
      r.series_id !== null ||
      !(Date.parse(r.created_at) < cutoff.getTime())
  );
  if (wrong.length > 0) {
    // The filter did not do what was asked. Nothing here is safe to act on.
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
