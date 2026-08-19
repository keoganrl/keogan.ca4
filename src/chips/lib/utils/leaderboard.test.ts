import { describe, it, expect } from 'vitest';
import { sortLifetimeStats } from './leaderboard';
import type { LifetimeStat } from '../types';

function row(name: string, over: Partial<LifetimeStat> = {}): LifetimeStat {
	return {
		identity_id: name,
		display_name: name,
		sessions_played: 5,
		total_net: 0,
		biggest_win: 0,
		times_first: 0,
		times_last: 0,
		total_buyin: 0,
		...over
	};
}

const names = (rows: LifetimeStat[]) => rows.map((r) => r.display_name);

describe('sortLifetimeStats', () => {
	it('ranks net, best win, and times first highest-first', () => {
		const rows = [
			row('low', { total_net: -500, biggest_win: 10, times_first: 0 }),
			row('high', { total_net: 900, biggest_win: 400, times_first: 4 }),
			row('mid', { total_net: 100, biggest_win: 250, times_first: 2 })
		];
		expect(names(sortLifetimeStats(rows, 'total_net'))).toEqual(['high', 'mid', 'low']);
		expect(names(sortLifetimeStats(rows, 'biggest_win'))).toEqual(['high', 'mid', 'low']);
		expect(names(sortLifetimeStats(rows, 'times_first'))).toEqual(['high', 'mid', 'low']);
	});

	it('ranks times last fewest-first — coming last is the thing being counted', () => {
		const rows = [row('often', { times_last: 6 }), row('never', { times_last: 0 })];
		expect(names(sortLifetimeStats(rows, 'times_last'))).toEqual(['never', 'often']);
	});

	it('ranks all-ins highest-first', () => {
		const rows = [
			row('nit', { all_ins: 1 }),
			row('maniac', { all_ins: 12 }),
			row('steady', { all_ins: 4 })
		];
		expect(names(sortLifetimeStats(rows, 'all_ins'))).toEqual(['maniac', 'steady', 'nit']);
	});

	it('treats a missing times_first as zero (database mid-migration)', () => {
		const stale = row('stale');
		delete (stale as Partial<LifetimeStat>).times_first;
		const rows = [stale, row('winner', { times_first: 3 })];
		expect(names(sortLifetimeStats(rows, 'times_first'))).toEqual(['winner', 'stale']);
	});

	it('treats a missing all_ins as zero — the column postdates events.all_in', () => {
		const rows = [row('stale'), row('shover', { all_ins: 7 })];
		expect(names(sortLifetimeStats(rows, 'all_ins'))).toEqual(['shover', 'stale']);
	});

	it('does not mutate the array it was given', () => {
		const rows = [row('a', { total_net: 1 }), row('b', { total_net: 2 })];
		sortLifetimeStats(rows, 'total_net');
		expect(names(rows)).toEqual(['a', 'b']);
	});
});
