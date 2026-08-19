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

/** A standard deviation of this many big blinds scores 100. */
export const CHAOS_FULL_SCALE_BB = 100;

/**
 * Ranks players by how violently their results swing from session to session.
 *
 * Measured in big blinds, never raw chips: a 5/10 tournament and a 1/2 cash game produce
 * results an order of magnitude apart, so a raw-chip standard deviation would mostly rank
 * people by which stakes they happened to show up for.
 *
 * The scale is ABSOLUTE — a standard deviation of 100bb scores 100 — which makes the
 * score mean the same thing every time it is rendered. An earlier version scored everyone
 * relative to the wildest player in the group; that manufactured a hierarchy out of noise
 * whenever the group swung by similar amounts, and a player's score moved when somebody
 * else had a big session. The number is now just their standard deviation in big blinds,
 * clamped at 100.
 *
 * Because of that clamp, ordering uses the raw swing rather than the score: two players
 * pinned at 100 are still ranked correctly against each other.
 *
 * Uses the sample standard deviation (n-1). These sessions are a sample of how someone
 * plays, not the complete population of every session they will ever play, and with the
 * handful a home game accumulates the n-1 correction is not a rounding detail — at n=3
 * it is a 22% difference.
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

	for (const s of scored) {
		if (s.sessionsPlayed < MIN_CHAOS_SESSIONS) continue;
		s.score = Math.min(100, Math.round((s.swing / CHAOS_FULL_SCALE_BB) * 100));
	}

	// Qualifying players first, wildest to steadiest; everyone still short of the minimum
	// trails behind in session order so they can see how close they are to appearing.
	return scored.sort((a, b) => {
		if ((a.score === null) !== (b.score === null)) return a.score === null ? 1 : -1;
		if (a.score === null) return b.sessionsPlayed - a.sessionsPlayed;
		return b.swing - a.swing;
	});
}
