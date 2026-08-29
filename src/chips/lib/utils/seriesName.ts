/**
 * Naming a series.
 *
 * A name is a short prefix the players choose plus the month the series started:
 * 'DW-2026-07'. The prefix is theirs to pick — it is usually where they play — and
 * the month is not, because a name people invent freely stops sorting.
 *
 * That is the whole reason the date half is generated rather than typed. The
 * directory lists series newest-first, and it can do that on the NAME alone: with a
 * fixed-width zero-padded YYYY-MM tail, lexicographic order and chronological order
 * are the same order. A hand-typed '2026-7' or 'july' breaks that quietly — the
 * list still renders, just in the wrong order.
 */

/** Prefixes are 2-5 letters. Uppercased on the way in, so 'dw' and 'DW' are one. */
const PREFIX = /^[A-Za-z]{2,5}$/;

export function isValidPrefix(prefix: string): boolean {
	return PREFIX.test(prefix.trim());
}

/**
 * Builds the full series name from a prefix and the month it starts in.
 *
 * Deliberately takes the date rather than reading the clock, so a test can pin a
 * month without faking timers. Uses the LOCAL month, not UTC: a series started at
 * late on the 31st belongs to the month the players were in, not the
 * one their timezone offset lands on.
 */
export function buildSeriesName(prefix: string, date: Date = new Date()): string {
	const clean = prefix.trim().toUpperCase();
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	return `${clean}-${year}-${month}`;
}
