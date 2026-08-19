import type { SessionResult } from '../types';

/** Below this many sessions a standard deviation is noise, not a read. */
export const MIN_CHAOS_SESSIONS = 3;

export interface ChaosScore {
	identityId: string;
	displayName: string;
	sessionsPlayed: number;
	/** Standard deviation of this player's per-night results, in big blinds. */
	swing: number;
	/** Biggest single-night win and loss, in big blinds — what the swing is made of. */
	bestNight: number;
	worstNight: number;
	/** 0-100, scaled against the wildest player in the group. Null when under the minimum. */
	score: number | null;
}

/**
 * Ranks players by how violently their results swing from night to night.
 *
 * Measured in big blinds, never raw chips: a 5/10 tournament and a 1/2 cash game produce
 * results an order of magnitude apart, so a raw-chip standard deviation would mostly rank
 * people by which stakes they happened to show up for.
 *
 * The score is relative — the wildest qualifying player is 100 and everyone else is a
 * share of that. There is no absolute scale for "chaotic" to measure against, and a
 * self-calibrating one stays meaningful as the group's stakes drift over time. It does
 * mean a score only compares within one rendering of the board.
 *
 * Uses the sample standard deviation (n-1). These nights are a sample of how someone
 * plays, not the complete population of every night they will ever play, and with the
 * handful of sessions a home game accumulates the n-1 correction is not a rounding
 * detail — at n=3 it is a 22% difference.
 */
export function chaosScores(rows: SessionResult[]): ChaosScore[] {
	const byPlayer = new Map<string, { name: string; values: number[] }>();
	for (const r of rows) {
		let entry = byPlayer.get(r.identity_id);
		if (!entry) {
			entry = { name: r.display_name, values: [] };
			byPlayer.set(r.identity_id, entry);
		}
		// net_bb arrives from Postgres numeric, which supabase-js hands back as a string on
		// some driver versions; coerce rather than trust it, or every sum becomes concatenation.
		entry.values.push(Number(r.net_bb) || 0);
	}

	const scored = [...byPlayer.entries()].map(([identityId, { name, values }]) => {
		const n = values.length;
		const mean = values.reduce((a, b) => a + b, 0) / n;
		const swing =
			n < 2
				? 0
				: Math.sqrt(values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1));
		return {
			identityId,
			displayName: name,
			sessionsPlayed: n,
			swing,
			bestNight: Math.max(...values),
			worstNight: Math.min(...values),
			score: null as number | null
		};
	});

	const qualifying = scored.filter((s) => s.sessionsPlayed >= MIN_CHAOS_SESSIONS);
	const wildest = Math.max(0, ...qualifying.map((s) => s.swing));
	for (const s of qualifying) {
		s.score = wildest > 0 ? Math.round((s.swing / wildest) * 100) : 0;
	}

	// Qualifying players first, wildest to steadiest; everyone still short of the minimum
	// trails behind in session order so they can see how close they are to appearing.
	return scored.sort((a, b) => {
		if ((a.score === null) !== (b.score === null)) return a.score === null ? 1 : -1;
		if (a.score === null) return b.sessionsPlayed - a.sessionsPlayed;
		return b.swing - a.swing;
	});
}
