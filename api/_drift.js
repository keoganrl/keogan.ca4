// Decides whose profile is stale enough to be worth rewriting.
//
// This runs in plain JavaScript before any model call, and most sessions it will
// decide the answer is "nobody" — which is the point. A profile that rewrites
// itself after every session has no weight; the ones that change should mean
// something. It also keeps the cost at zero on a quiet session.

// How far a figure has to move before the text describing it is out of date.
// Percentage points for the three rates, raw units for aggression factor (which
// runs roughly 0.1–2.5 here, so 0.3 is a visible shift in how someone plays).
// Started at 5 / 5 / 5 / 0.3 and profiles felt stale for whole sessions at a time:
// these are running averages over a series, so each session moves them less than
// the last. Tightened after a season of play.
export const THRESHOLDS = {
	vpip_pct: 3,
	pfr_pct: 3,
	wtsd_pct: 3,
	af: 0.2
};

// The other reason to rewrite: the sample has grown by half since the text was
// written. Averages can sit still while the evidence behind them doubles, and a
// profile written off 40 hands should not still be the one shown at 400. Being
// relative, it fires every session or two early in a series and spaces itself out
// as the hand count climbs, which is the right shape for how much a profile can learn.
export const HANDS_GROWTH = 1.5;

function moved(before, after, limit) {
	// Null is "no figure yet", not zero. Gaining a figure you did not have is new
	// information about the player; losing one cannot happen, since these only
	// accumulate. Two nulls are two absences and no news.
	if (before === null || before === undefined) {
		return after !== null && after !== undefined;
	}
	if (after === null || after === undefined) return false;
	// Rounded before comparing: 1.5 - 1.2 is 0.30000000000000004 in floating point,
	// so a figure that moved EXACTLY the threshold would otherwise count as having
	// exceeded it — and these are stats carrying one or two decimals, where a
	// difference in the sixteenth place is not a change in how someone plays.
	return Number((Math.abs(after - before)).toFixed(6)) > limit;
}

/**
 * True when this player's numbers have moved far enough that the text written
 * about them no longer fits, or when there is no text yet.
 */
export function needsRewrite(current, previous) {
	if (!previous) return true;
	// A snapshot from before hands were stored has no baseline, and is left to the
	// thresholds rather than read as growth: otherwise the deploy that started storing
	// it would rewrite every profile on its player's next session.
	if (previous.hands > 0 && current.hands >= previous.hands * HANDS_GROWTH) return true;
	return Object.entries(THRESHOLDS).some(([key, limit]) =>
		moved(previous[key], current[key], limit)
	);
}

/**
 * Who to rewrite after a session ends.
 *
 * `participantIds` gates the whole thing: only people who actually played can
 * have moved. That is mostly redundant — someone absent cannot have new numbers —
 * but it is a real safeguard against the case where the STATS change for another
 * reason, such as a fix to the view's arithmetic. Without it, one corrected
 * calculation would rewrite every profile at the table at once. With
 * it, each player's profile catches up the next time they play.
 */
export function selectForRewrite({ stats, profiles, participantIds }) {
	const previous = new Map(profiles.map((p) => [p.identity_id, p]));
	const played = new Set(participantIds);

	return stats
		.filter((s) => played.has(s.identity_id))
		.filter((s) => {
			const row = previous.get(s.identity_id);
			// A row with no profile text yet always qualifies, however little it moved.
			if (!row || !row.profile) return true;
			return needsRewrite(s, row.stats_snapshot);
		})
		.map((s) => s.identity_id);
}

/** The subset of a stats row worth storing to compare against next time. */
export function snapshotOf(stat) {
	const snap = {};
	for (const key of Object.keys(THRESHOLDS)) snap[key] = stat[key] ?? null;
	snap.hands = stat.hands ?? null;
	return snap;
}
