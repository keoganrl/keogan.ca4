import { describe, it, expect } from 'vitest';
import { chaosScores, MIN_CHAOS_SESSIONS, CHAOS_FULL_SCALE_BB } from './chaos';
import type { SessionResult } from '../types';

function rows(identity: string, netBbs: number[], bigBlind = 2): SessionResult[] {
	return netBbs.map((bb, i) => ({
		identity_id: identity,
		display_name: identity,
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
	it('scores on an absolute scale where a 100bb deviation is 100', () => {
		// values -50, 50 repeated → sample sd of exactly 100bb would score 100;
		// this set lands well under it and must not be inflated to 100.
		const scores = chaosScores([
			...rows('wild', [-100, 100, -80, 90]),
			...rows('steady', [1, -1, 2, -2])
		]);
		const wild = find(scores, 'wild');
		expect(wild.score).toBe(Math.min(100, Math.round(wild.swing)));
		expect(find(scores, 'steady').score!).toBeLessThan(10);
		expect(scores[0].identityId).toBe('wild');
	});

	it('does not move a player’s score when someone else has a big session', () => {
		const ada = rows('ada', [10, -10, 20, -20]);
		const alone = find(chaosScores(ada), 'ada').score;
		const withWildcard = find(chaosScores([...ada, ...rows('wild', [-900, 900, -800])]), 'ada').score;
		expect(withWildcard).toBe(alone);
	});

	it('clamps at 100 but still ranks two clamped players by their real swing', () => {
		const scores = chaosScores([
			...rows('big', [-200, 200, -150]),
			...rows('bigger', [-600, 600, -500])
		]);
		expect(find(scores, 'big').score).toBe(100);
		expect(find(scores, 'bigger').score).toBe(100);
		// the cap ties the displayed score, so ordering must come from the raw swing
		expect(scores[0].identityId).toBe('bigger');
	});

	it('scores a deviation of exactly the full-scale value as 100', () => {
		// -100, 100 has a sample sd of ~141; use a set whose sd is exactly 100:
		// -100, 0, 100 → sd 100
		const scores = chaosScores(rows('exact', [-100, 0, 100]));
		expect(find(scores, 'exact').swing).toBeCloseTo(CHAOS_FULL_SCALE_BB);
		expect(find(scores, 'exact').score).toBe(100);
	});

	it('gives a perfectly consistent player a swing of zero', () => {
		const scores = chaosScores([...rows('flat', [5, 5, 5, 5]), ...rows('wild', [-90, 90, -90])]);
		expect(find(scores, 'flat').swing).toBe(0);
		expect(find(scores, 'flat').score).toBe(0);
	});

	it('withholds a score below the session minimum', () => {
		const scores = chaosScores([
			...rows('newbie', Array(MIN_CHAOS_SESSIONS - 1).fill(0).map((_, i) => i * 50)),
			...rows('regular', [10, -10, 20, -20])
		]);
		expect(find(scores, 'newbie').score).toBeNull();
		expect(find(scores, 'regular').score).not.toBeNull();
	});

	it('sorts unqualified players last regardless of how wildly they swung', () => {
		const scores = chaosScores([
			...rows('twoNights', [-500, 500]),
			...rows('regular', [1, -1, 2, -2])
		]);
		expect(scores[0].identityId).toBe('regular');
		expect(scores[scores.length - 1].identityId).toBe('twoNights');
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

	it('reports the best and worst night behind the swing', () => {
		const scores = chaosScores(rows('ada', [-45, 12, 88]));
		expect(find(scores, 'ada').bestNight).toBe(88);
		expect(find(scores, 'ada').worstNight).toBe(-45);
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
