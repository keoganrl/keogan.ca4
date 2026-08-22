import type { SessionResult } from '../types';

/**
 * Categorical palette for the net chart, in fixed slot order.
 *
 * The order is the colourblind-safety mechanism, not decoration: consecutive slots are
 * the pairs most likely to sit next to each other, and this ordering clears protanopia
 * and deuteranopia separation on the chips paper surface. Assign slots in sequence and
 * never reorder them — re-deriving the palette means re-validating it.
 *
 * Three slots (aqua, yellow, magenta) sit under 3:1 contrast against the paper. That is
 * allowed only because identity is never carried by colour alone here: every line is also
 * named in the list underneath, with its swatch beside the name.
 */
export const SERIES_COLORS = [
	'#2a78d6', // blue
	'#eb6834', // orange
	'#1baf7a', // aqua
	'#eda100', // yellow
	'#e87ba4', // magenta
	'#008300', // green
	'#4a3aa7', // violet
	'#e34948' // red
] as const;

export interface PlayerSeries {
	identityId: string;
	displayName: string;
	color: string;
	/** Past slot 8 the palette repeats, so a dashed stroke keeps the pair apart. */
	dashed: boolean;
	/** Cumulative net after each session in `sessionIds` order; index 0 is the pre-game zero. */
	points: number[];
	/** Where this player's own history starts — before it the running total is a flat zero. */
	firstIndex: number;
	total: number;
}

export interface NetSeriesData {
	/** Every ended session, oldest first. Index i in a series' points is *after* session i-1. */
	sessionIds: string[];
	sessionDates: string[];
	series: PlayerSeries[];
	min: number;
	max: number;
}

/**
 * Turns per-session rows into one cumulative line per player.
 *
 * Every line shares an x-axis of *global* session number, not each player's own count —
 * a player's third session and someone else's third session are usually different
 * evenings, so per-player indexing would silently compare unrelated points. On a
 * session a player sat out, their total carries forward flat: they neither won nor lost.
 *
 * All lines start at zero at index 0 (before any session). A player who debuts late is
 * flat at zero until then, which is true — they had no results yet — and keeps every
 * line on one origin.
 */
export function buildNetSeries(rows: SessionResult[]): NetSeriesData {
	// Chronological session order, deduped. created_at ties are broken by session_id so the
	// axis is deterministic — two sessions ended in the same second must not reorder between
	// loads, or the chart would visibly reshuffle for no reason.
	const sessionMeta = new Map<string, string>();
	for (const r of rows) sessionMeta.set(r.session_id, r.created_at);

	const sessionIds = [...sessionMeta.keys()].sort((a, b) => {
		const byDate = (sessionMeta.get(a) ?? '').localeCompare(sessionMeta.get(b) ?? '');
		return byDate !== 0 ? byDate : a.localeCompare(b);
	});
	const indexOf = new Map(sessionIds.map((id, i) => [id, i]));
	const sessionDates = sessionIds.map((id) => sessionMeta.get(id) ?? '');

	// Group rows by player.
	const byPlayer = new Map<string, { name: string; nets: Map<number, number> }>();
	for (const r of rows) {
		const idx = indexOf.get(r.session_id);
		if (idx === undefined) continue;
		let entry = byPlayer.get(r.identity_id);
		if (!entry) {
			entry = { name: r.display_name, nets: new Map() };
			byPlayer.set(r.identity_id, entry);
		}
		// A player should have one row per session; if duplicates ever appear (an unmerged
		// identity seated twice), add rather than overwrite so no chips silently vanish.
		entry.nets.set(idx, (entry.nets.get(idx) ?? 0) + r.net);
	}

	// Colour is assigned by debut order and never by rank. Rank changes every session, so
	// rank-coloured lines would repaint the whole chart after every session and nobody could
	// track their own line across two visits. Debut order is stable for good.
	const debutOf = (id: string) => Math.min(...[...(byPlayer.get(id)?.nets.keys() ?? [0])]);
	const orderedIds = [...byPlayer.keys()].sort((a, b) => {
		const byDebut = debutOf(a) - debutOf(b);
		return byDebut !== 0 ? byDebut : a.localeCompare(b);
	});

	let min = 0;
	let max = 0;
	const series: PlayerSeries[] = orderedIds.map((identityId, i) => {
		const entry = byPlayer.get(identityId)!;
		const firstIndex = debutOf(identityId);
		const points: number[] = [0];
		let running = 0;
		for (let s = 0; s < sessionIds.length; s++) {
			running += entry.nets.get(s) ?? 0;
			points.push(running);
			if (running < min) min = running;
			if (running > max) max = running;
		}
		return {
			identityId,
			displayName: entry.name,
			color: SERIES_COLORS[i % SERIES_COLORS.length],
			dashed: i >= SERIES_COLORS.length,
			points,
			firstIndex,
			total: running
		};
	});

	return { sessionIds, sessionDates, series, min, max };
}

export interface Scale {
	min: number;
	max: number;
	ticks: number[];
}

/**
 * Chooses a y-range that covers the data and lands on round gridlines.
 *
 * Always includes zero — on a profit chart the zero line is the thing people read against,
 * so a range that floats above or below it would flatter or flatten everyone equally.
 */
export function niceScale(dataMin: number, dataMax: number, targetTicks = 5): Scale {
	const lo = Math.min(0, dataMin);
	const hi = Math.max(0, dataMax);
	if (lo === hi) return { min: -1, max: 1, ticks: [-1, 0, 1] };

	const rawStep = (hi - lo) / Math.max(1, targetTicks);
	const magnitude = 10 ** Math.floor(Math.log10(rawStep));
	// Round the step up to 1, 2, 5 or 10 x a power of ten so labels stay mentally divisible.
	const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rawStep) ?? 10 * magnitude;

	const min = Math.floor(lo / step) * step;
	const max = Math.ceil(hi / step) * step;
	const ticks: number[] = [];
	// Accumulate with a rounding guard: repeated float addition of e.g. 0.1 drifts, which
	// would render a gridline labelled "-1.3877787807814457e-17" instead of "0".
	const decimals = Math.max(0, -Math.floor(Math.log10(step)));
	for (let v = min; v <= max + step / 2; v += step) {
		ticks.push(Number(v.toFixed(decimals)));
	}
	return { min, max, ticks };
}

/** SVG polyline points for one series, clipped to the sessions the player has existed for. */
export function seriesPath(
	s: PlayerSeries,
	scale: Scale,
	width: number,
	height: number,
	sessionCount: number
): string {
	const xStep = sessionCount > 0 ? width / sessionCount : width;
	const span = scale.max - scale.min || 1;
	const coords: string[] = [];
	for (let i = s.firstIndex; i < s.points.length; i++) {
		const x = i * xStep;
		const y = height - ((s.points[i] - scale.min) / span) * height;
		coords.push(`${x.toFixed(2)},${y.toFixed(2)}`);
	}
	return coords.join(' ');
}
