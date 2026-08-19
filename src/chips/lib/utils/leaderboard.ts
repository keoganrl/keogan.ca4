import type { LifetimeStat } from '../types';

export type LeaderboardSortKey =
	| 'total_net'
	| 'biggest_win'
	| 'times_first'
	| 'times_last'
	| 'all_ins';

// times_first and all_ins only exist once lifetime_stats has been re-created with those
// columns, so every stat is read defensively — a database mid-migration should rank as
// zeroes rather than NaN (which sorts unpredictably).
const stat = (s: LifetimeStat, key: LeaderboardSortKey): number => s[key] ?? 0;

/**
 * Orders the lifetime board by one column, best-first.
 *
 * Every column is highest-first except times_last, where finishing bottom of the
 * table is the thing being counted — fewest is best there.
 */
export function sortLifetimeStats(
	stats: LifetimeStat[],
	sortBy: LeaderboardSortKey
): LifetimeStat[] {
	return [...stats].sort((a, b) =>
		sortBy === 'times_last'
			? stat(a, sortBy) - stat(b, sortBy)
			: stat(b, sortBy) - stat(a, sortBy)
	);
}
