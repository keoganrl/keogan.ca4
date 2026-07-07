import { describe, it, expect } from 'vitest';
import { computePots, resolveAward, type Pot } from './pots';
import type { Player } from '../types';

// Only the fields computePots/resolveAward read matter; the rest are stubbed.
function player(
	id: string,
	seat_order: number,
	hand_total_bet: number,
	opts: { folded?: boolean; is_active?: boolean } = {}
): Player {
	return {
		id,
		session_id: 's',
		identity_id: id,
		display_name: id,
		stack: 0,
		total_buyin: 0,
		is_host: false,
		is_active: opts.is_active ?? true,
		folded: opts.folded ?? false,
		current_round_bet: 0,
		acted_on_street: null,
		hand_total_bet,
		last_heartbeat_at: '',
		seat_order
	};
}

const total = (payouts: Record<string, number>) =>
	Object.values(payouts).reduce((a, b) => a + b, 0);

describe('computePots', () => {
	it('single level: one pot, everyone eligible', () => {
		const pots = computePots([player('a', 0, 100), player('b', 1, 100), player('c', 2, 100)]);
		expect(pots).toEqual([{ amount: 300, eligibleIds: ['a', 'b', 'c'] }]);
	});

	it('all-in short stack creates a side pot; folded money counts but cannot win', () => {
		const pots = computePots([
			player('short', 0, 50),
			player('deep1', 1, 200),
			player('deep2', 2, 200),
			player('folder', 3, 100, { folded: true })
		]);
		// main: 50×4 = 200; side: folder contributes 100−50=50 dead + deeps 150 each
		expect(pots[0]).toEqual({ amount: 200, eligibleIds: ['short', 'deep1', 'deep2'] });
		expect(pots[1]).toEqual({ amount: 350, eligibleIds: ['deep1', 'deep2'] });
	});
});

describe('resolveAward', () => {
	const pots: Pot[] = [
		{ amount: 200, eligibleIds: ['short', 'deep1', 'deep2'] },
		{ amount: 350, eligibleIds: ['deep1', 'deep2'] }
	];
	const players = [player('short', 0, 50), player('deep1', 1, 200), player('deep2', 2, 200)];

	it('deep-stack winner takes every pot in one round', () => {
		const res = resolveAward(pots, ['deep1'], players, 'short');
		expect(res.payouts).toEqual({ deep1: 550 });
		expect(res.remainingPots).toEqual([]);
	});

	it('short-stack winner takes only the main pot; side pot survives to the next round', () => {
		const round1 = resolveAward(pots, ['short'], players, 'short');
		expect(round1.payouts).toEqual({ short: 200 });
		expect(round1.remainingPots).toEqual([{ amount: 350, eligibleIds: ['deep1', 'deep2'] }]);

		const round2 = resolveAward(round1.remainingPots, ['deep2'], players, 'short');
		expect(round2.payouts).toEqual({ deep2: 350 });
		expect(round2.remainingPots).toEqual([]);
	});

	it('two-way tie splits each pot; odd chip goes to the first seat left of the button', () => {
		const res = resolveAward(
			[{ amount: 101, eligibleIds: ['a', 'b', 'c'] }],
			['a', 'b'],
			[player('a', 0, 0), player('b', 1, 0), player('c', 2, 0)],
			'a' // button on a → odd-chip order starts at b
		);
		expect(res.payouts).toEqual({ b: 51, a: 50 });
		expect(total(res.payouts)).toBe(101);
	});

	it('tie between a short and a deep stack: main split, side pot all to the deep stack', () => {
		const res = resolveAward(pots, ['short', 'deep1'], players, 'deep2');
		expect(res.payouts).toEqual({ short: 100, deep1: 100 + 350 });
		expect(res.remainingPots).toEqual([]);
		expect(total(res.payouts)).toBe(550);
	});

	it('three-way tie with two odd chips distributes deterministically and exactly', () => {
		const res = resolveAward(
			[{ amount: 200, eligibleIds: ['a', 'b', 'c'] }],
			['a', 'b', 'c'],
			[player('a', 0, 0), player('b', 1, 0), player('c', 2, 0)],
			'b' // order left of button: c, a, b
		);
		expect(res.payouts).toEqual({ c: 67, a: 67, b: 66 });
		expect(total(res.payouts)).toBe(200);
	});

	it('winners not eligible for any pot leave everything unresolved', () => {
		const res = resolveAward(pots.slice(1), ['short'], players, null);
		expect(res.payouts).toEqual({});
		expect(res.remainingPots).toEqual(pots.slice(1));
	});
});
