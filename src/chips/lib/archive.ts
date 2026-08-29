import type { LifetimeStat, PlayerProfile, PlayerStat, SessionResult } from './types';

/**
 * A frozen series: everything its leaderboard needs, and nothing that would let it
 * be reconstructed. Written by scripts/end-series.mjs, read at BUILD time only.
 */
export interface SeriesArchive {
	name: string;
	endedAt: string | null;
	stats: LifetimeStat[];
	results: SessionResult[];
	/** Public blurbs only — `coaching` is stripped before this is committed. */
	profiles: PlayerProfile[];
	playerStats: PlayerStat[];
}

// Eagerly imported so getStaticPaths() can enumerate them synchronously. The glob is
// relative to this file, and it is the only place archives are read: adding a series
// means committing a file here, with no route to register.
const files = import.meta.glob<SeriesArchive>('../archive/*.json', {
	eager: true,
	import: 'default'
});

export function allArchives(): SeriesArchive[] {
	return Object.values(files).sort((a, b) => b.name.localeCompare(a.name));
}

export function handCountsOf(archive: SeriesArchive): { identity_id: string; hands: number }[] {
	return archive.playerStats.map((s) => ({ identity_id: s.identity_id, hands: s.hands }));
}
