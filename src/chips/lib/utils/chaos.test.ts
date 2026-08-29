import { describe, it, expect } from 'vitest';
import { chaosScores, MIN_CHAOS_SESSIONS } from './chaos';
import type { SessionResult } from '../types';

function rows(identity: string, netBbs: number[], bigBlind = 2): SessionResult[] {
	return netBbs.map((bb, i) => ({
		identity_id: identity,
		display_name: identity,
		series_id: 'series-1',
		session_id: `${identity}-${i}`,
		created_at: `2026-01-0${i + 1}T00:00:00Z`,
		big_blind: bigBlind,
		net: bb * bigBlind,
		net_bb: bb
	}));
}

const find = (list: ReturnType<typeof chaosScores>, id: string) =>
	list.find((s) => s.identityId === id)!;

describe('chaosScores', () => {
	// One human, two chairs in the same session — they joined again from a private tab
	// and the identities were merged afterwards. session_results has a row per seat.
	it('counts a session played from two seats once', () => {
		const twoSeats: SessionResult[] = [
			{
				identity_id: 'me',
				display_name: 'me',
				series_id: 'series-1',
				session_id: 'night-1',
				created_at: '2026-01-01T00:00:00Z',
				big_blind: 2,
				net: 60,
				net_bb: 30
			},
			{
				identity_id: 'me',
				display_name: 'me',
				series_id: 'series-1',
				session_id: 'night-1',
				created_at: '2026-01-01T00:00:00Z',
				big_blind: 2,
				net: 40,
				net_bb: 20
			},
			...rows('me', [-10, 5]).map((r, i) => ({ ...r, session_id: `night-${i + 2}` }))
		];

		const me = find(chaosScores(twoSeats), 'me');
		// Three nights, not four.
		expect(me.sessionsPlayed).toBe(3);
		// And the night was +50bb across the two chairs, not a +30 and a +20 — which as
		// two separate results would read as a steadier player than they were.
		expect(me.bestSession).toBe(50);
	});

	it('ranks the wilder player above the steadier one', () => {
		const scores = chaosScores([
			...rows('wild', [-100, 100, -80, 90]),
			...rows('steady', [1, -1, 2, -2])
		]);
		expect(scores[0].identityId).toBe('wild');
		expect(find(scores, 'wild').swing).toBeGreaterThan(find(scores, 'steady').swing);
	});

	it('does not move a player’s number when someone else has a big session', () => {
		const ada = rows('ada', [10, -10, 20, -20]);
		const alone = find(chaosScores(ada), 'ada').swing;
		const withWildcard = find(chaosScores([...ada, ...rows('wild', [-900, 900, -800])]), 'ada').swing;
		expect(withWildcard).toBeCloseTo(alone);
	});

	it('does not cap a very wild player, so the tail stays visible', () => {
		// Both would have pinned at 100 under the old clamped scale, hiding a 4x gap.
		const scores = chaosScores([
			...rows('big', [-200, 200, -150]),
			...rows('bigger', [-800, 800, -700])
		]);
		expect(find(scores, 'big').swing).toBeGreaterThan(100);
		expect(find(scores, 'bigger').swing).toBeGreaterThan(find(scores, 'big').swing * 2);
		expect(scores[0].identityId).toBe('bigger');
	});

	it('gives a perfectly consistent player a swing of zero', () => {
		const scores = chaosScores([...rows('flat', [5, 5, 5, 5]), ...rows('wild', [-90, 90, -90])]);
		expect(find(scores, 'flat').swing).toBe(0);
		expect(find(scores, 'flat').qualified).toBe(true);
	});

	it('withholds a score below the session minimum', () => {
		const scores = chaosScores([
			...rows('newbie', Array(MIN_CHAOS_SESSIONS - 1).fill(0).map((_, i) => i * 50)),
			...rows('regular', [10, -10, 20, -20])
		]);
		expect(find(scores, 'newbie').qualified).toBe(false);
		expect(find(scores, 'regular').qualified).toBe(true);
	});

	it('sorts unqualified players last regardless of how wildly they swung', () => {
		const scores = chaosScores([
			...rows('twoSessions', [-500, 500]),
			...rows('regular', [1, -1, 2, -2])
		]);
		expect(scores[0].identityId).toBe('regular');
		expect(scores[scores.length - 1].identityId).toBe('twoSessions');
	});

	it('measures swing in big blinds, so stakes do not decide the ranking', () => {
		// Identical results in BB terms; one played 1/2, the other 25/50.
		const scores = chaosScores([
			...rows('smallStakes', [-40, 40, -30], 2),
			...rows('bigStakes', [-40, 40, -30], 50)
		]);
		expect(find(scores, 'smallStakes').swing).toBeCloseTo(find(scores, 'bigStakes').swing);
	});

	it('uses the sample standard deviation, not the population one', () => {
		// values -10, 0, 10 → sample sd 10, population sd ~8.165
		const scores = chaosScores(rows('trio', [-10, 0, 10]));
		expect(find(scores, 'trio').swing).toBeCloseTo(10);
	});

	it('reports the best and worst session behind the swing', () => {
		const scores = chaosScores(rows('ada', [-45, 12, 88]));
		expect(find(scores, 'ada').bestSession).toBe(88);
		expect(find(scores, 'ada').worstSession).toBe(-45);
	});

	it('coerces numeric strings from the driver instead of concatenating them', () => {
		const raw = rows('ada', [10, -10, 30]).map((r) => ({
			...r,
			net_bb: String(r.net_bb) as unknown as number
		}));
		const scores = chaosScores(raw);
		expect(Number.isFinite(find(scores, 'ada').swing)).toBe(true);
		expect(find(scores, 'ada').swing).toBeGreaterThan(0);
	});

	it('returns nothing for no rows', () => {
		expect(chaosScores([])).toEqual([]);
	});
});
