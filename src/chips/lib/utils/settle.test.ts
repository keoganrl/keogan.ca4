import { describe, it, expect } from 'vitest';
import {
	apportion,
	balancesFromResults,
	settleExact,
	settleRough,
	type Balance,
	type Settlement
} from './settle';

const bal = (...cents: number[]): Balance[] => cents.map((c, i) => ({ id: `p${i}`, cents: c }));

// What each player ends up with from the transfers alone.
function received(s: Settlement, ids: string[]): Record<string, number> {
	const got: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
	for (const t of s.transfers) {
		got[t.to] += t.cents;
		got[t.from] -= t.cents;
	}
	return got;
}

// Fewest transfers by brute force: n minus the most disjoint zero-sum groups, found by
// trying every way to assign players to group labels. Only for tiny tables.
function bruteMinTransfers(b: Balance[]): number {
	const xs = b.map((x) => x.cents).filter((c) => c !== 0);
	let best = 0;
	const labels = new Array(xs.length).fill(0);
	const walk = (i: number, used: number) => {
		if (i === xs.length) {
			const sums = new Array(used).fill(0);
			xs.forEach((x, j) => (sums[labels[j]] += x));
			if (sums.every((s) => s === 0)) best = Math.max(best, used);
			return;
		}
		for (let l = 0; l <= used; l++) {
			labels[i] = l;
			walk(i + 1, Math.max(used, l + 1));
		}
	};
	walk(0, 0);
	return xs.length - best;
}

describe('apportion', () => {
	it('hits the total exactly, rounding the biggest fractions up', () => {
		expect(apportion([1.5, 1.5, 1.0], 4)).toEqual([2, 1, 1]);
		expect(apportion([-1.5, 1.5], 0)).toEqual([-1, 1]);
	});
});

describe('balancesFromResults', () => {
	it('converts nets to cents and sums to zero even when the stake rounds', () => {
		// $15 a buy-in: 1.5 cents a chip, so 1 chip nets are half-cents.
		const players = [
			{ id: 'a', stack: 1001, total_buyin: 1000 },
			{ id: 'b', stack: 1001, total_buyin: 1000 },
			{ id: 'c', stack: 998, total_buyin: 1000 }
		];
		const { balances, gap } = balancesFromResults(players, 0.015);
		expect(gap).toBe(0);
		expect(balances.reduce((a, b) => a + b.cents, 0)).toBe(0);
		expect(balances.map((b) => b.cents).sort()).toEqual([-3, 1, 2].sort());
	});

	it('trims the heavier side when the table itself did not balance', () => {
		const players = [
			{ id: 'a', stack: 1600, total_buyin: 1000 },
			{ id: 'b', stack: 600, total_buyin: 1000 }
		];
		const { balances, gap } = balancesFromResults(players, 0.01);
		expect(gap).toBe(200);
		expect(balances).toEqual([
			{ id: 'a', cents: 400 },
			{ id: 'b', cents: -400 }
		]);
	});
});

describe('settleExact', () => {
	it('settles everybody to the cent', () => {
		const b = bal(1240, 500, -900, -840);
		const s = settleExact(b);
		expect(s.off).toEqual([]);
		expect(s.misallocated).toBe(0);
		const got = received(s, b.map((x) => x.id));
		for (const x of b) expect(got[x.id]).toBe(x.cents);
	});

	it('finds independent pairs instead of routing everything through one person', () => {
		// Greedy biggest-to-biggest would pay 700 to the 700 and then chain the rest;
		// the pairs (+700,-700), (+300,-300), (+50,-50) need only three.
		const s = settleExact(bal(700, 300, 50, -700, -300, -50));
		expect(s.transfers).toHaveLength(3);
	});

	it('matches brute force on random small tables', () => {
		let seed = 7;
		const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
		for (let trial = 0; trial < 200; trial++) {
			const n = 2 + Math.floor(rand() * 6);
			// Coarse values so zero-sum subgroups actually turn up.
			const cents = Array.from({ length: n - 1 }, () => Math.round((rand() - 0.5) * 8) * 100);
			cents.push(-cents.reduce((a, c) => a + c, 0));
			const b = bal(...cents);
			const s = settleExact(b);
			expect(s.off).toEqual([]);
			expect(s.transfers).toHaveLength(bruteMinTransfers(b));
		}
	});

	it('handles everybody breaking even', () => {
		expect(settleExact(bal(0, 0, 0)).transfers).toEqual([]);
	});
});

describe('settleRough', () => {
	it('drops a small win rather than spending a transfer on it', () => {
		// $50 won by p0, $3 by p1; exact needs three transfers. Leaving p1's $3 out
		// misallocates $3 of $53 (under 8%) and saves one.
		const b = bal(5000, 300, -3000, -2300);
		expect(settleExact(b).transfers).toHaveLength(3);
		const s = settleRough(b);
		expect(s.transfers).toHaveLength(2);
		expect(s.misallocated).toBeLessThanOrEqual(0.08 * 5300);
		expect(s.transfers.every((t) => t.from !== 'p1' && t.to !== 'p1')).toBe(true);
	});

	it('never misallocates more than the tolerance', () => {
		let seed = 11;
		const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
		for (let trial = 0; trial < 200; trial++) {
			const n = 2 + Math.floor(rand() * 7);
			const cents = Array.from({ length: n - 1 }, () => Math.round((rand() - 0.5) * 6000));
			cents.push(-cents.reduce((a, c) => a + c, 0));
			const b = bal(...cents);
			const owed = cents.reduce((a, c) => a + Math.max(c, 0), 0);
			const rough = settleRough(b);
			const exact = settleExact(b);
			expect(rough.misallocated).toBeLessThanOrEqual(Math.floor(owed * 0.08));
			expect(rough.transfers.length).toBeLessThanOrEqual(exact.transfers.length);
			// `off` really is what the transfers leave each person with, minus what they were owed.
			const got = received(rough, b.map((x) => x.id));
			for (const x of b) {
				const off = rough.off.find((o) => o.id === x.id)?.cents ?? 0;
				expect(got[x.id] - x.cents).toBe(off);
			}
		}
	});

	it('rounds to whole dollars when the tolerance allows it', () => {
		const s = settleRough(bal(2830, -2830));
		expect(s.transfers).toEqual([{ from: 'p1', to: 'p0', cents: 2800 }]);
	});

	it('keeps the cents when whole dollars would misallocate too much', () => {
		// $0.40 changing hands: rounding to $0 is never allowed, and $1 is way off.
		const s = settleRough(bal(40, -40));
		expect(s.transfers).toEqual([{ from: 'p1', to: 'p0', cents: 40 }]);
	});
});
