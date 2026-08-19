import type { SessionResult } from '../types';

/** Below this many sessions a standard deviation is noise, not a read. */
export const MIN_CHAOS_SESSIONS = 3;

export interface ChaosScore {
	identityId: string;
	displayName: string;
	sessionsPlayed: number;
	/** Standard deviation of this player's per-session results, in big blinds. */
	swing: number;
	/** Biggest single-session win and loss, in big blinds — what the swing is made of. */
	bestNight: number;
	worstNight: number;
	/** False below MIN_CHAOS_SESSIONS, where a deviation is noise rather than a read. */
	qualified: boolean;
}

/**
 * Ranks players by how violently their results swing from session to session.
 *
 * The number reported IS the standard deviation, in big blinds. Not a score out of
 * anything: there is no natural maximum for how wildly someone can run, so any ceiling
 * would be invented, and capping at one would both discard the difference between a wild
 * player and a very wild player and tie them at the top. Two earlier attempts got this
 * wrong in opposite directions — scoring everyone relative to the wildest player in the
 * group manufactured a hierarchy out of noise and moved your number when somebody else
 * had a big session; clamping to an arbitrary 100 threw away the tail. A raw deviation
 * has neither problem and means the same thing every time it renders.
 *
 * Big blinds, never raw chips: a 5/10 tournament and a 1/2 cash game produce results an
 * order of magnitude apart, so a raw-chip deviation would mostly rank people by which
 * stakes they happened to show up for.
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
			qualified: n >= MIN_CHAOS_SESSIONS
		};
	});

	// Qualifying players first, wildest to steadiest; everyone still short of the minimum
	// trails behind in session order so they can see how close they are to appearing.
	return scored.sort((a, b) => {
		if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
		if (!a.qualified) return b.sessionsPlayed - a.sessionsPlayed;
		return b.swing - a.swing;
	});
}
