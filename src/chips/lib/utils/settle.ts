// Who e-transfers whom at the end of a money game, in two versions:
//
// - EXACT: the fewest transfers that settle every balance to the cent.
// - ROUGH: fewer transfers still, by letting up to ROUGH_TOLERANCE of the money that
//   changes hands land in the wrong pocket. Its job is to delete the small, annoying
//   transfers ("send Ben $1.40") and round what is left to whole dollars.
//
// Everything is in integer cents. A balance is positive for someone who is owed money
// (finished up) and negative for someone who owes it.
//
// The exact minimum is a known NP-hard problem, but a poker table is small. Settling a
// group of k people whose balances sum to zero takes k - 1 transfers, so the fewest
// transfers overall is n - (the most disjoint zero-sum groups the players split into),
// which a subset DP finds exactly for any table this app will ever seat.

export interface Balance {
	id: string;
	cents: number;
}

export interface Transfer {
	from: string;
	to: string;
	cents: number;
}

export interface Settlement {
	transfers: Transfer[];
	// Per player, what they end up with minus what they were owed (0 for everybody in
	// the exact version). Positive: came out ahead. Only non-zero entries are listed.
	off: Balance[];
	// Money that ended up in the wrong pocket: the sum of the positive `off` entries.
	misallocated: number;
}

export const ROUGH_TOLERANCE = 0.08;

// Past these the DPs get slow (n·2^n and n·3^n). No table gets near them; beyond them
// both versions fall back to settling the whole table as one greedy group, which is
// still at most n - 1 transfers.
const EXACT_MAX = 16;
const ROUGH_MAX = 12;

/**
 * Integers summing to exactly `total`, each the floor or ceiling of its value, with
 * the leftover cents going to the largest fractional parts (largest remainder).
 * Works for negative values too.
 */
export function apportion(values: number[], total: number): number[] {
	const floors = values.map((v) => Math.floor(v));
	let left = total - floors.reduce((a, b) => a + b, 0);
	const order = values
		.map((v, i) => ({ i, frac: v - Math.floor(v) }))
		.sort((a, b) => b.frac - a.frac || a.i - b.i);
	for (let k = 0; left > 0 && k < order.length; k++, left--) floors[order[k].i] += 1;
	return floors;
}

// Scales a list of same-sign balances so their total is `target` (same sign), keeping
// proportions and whole cents.
function scaleTo(list: Balance[], target: number): Balance[] {
	const sum = list.reduce((a, b) => a + b.cents, 0);
	if (sum === 0) return list;
	const cents = apportion(
		list.map((b) => (b.cents * target) / sum),
		target
	);
	return list.map((b, i) => ({ id: b.id, cents: cents[i] }));
}

// Makes a set of balances sum to zero by trimming the heavier side proportionally:
// if the winners are owed more than the losers owe, every winner gives up the same
// fraction. Returns them in the original order.
function balanceOut(group: Balance[]): Balance[] {
	const pos = group.filter((b) => b.cents > 0);
	const neg = group.filter((b) => b.cents < 0);
	const P = pos.reduce((a, b) => a + b.cents, 0);
	const N = -neg.reduce((a, b) => a + b.cents, 0);
	const fixed = new Map<string, number>();
	const scaled = P > N ? scaleTo(pos, N) : N > P ? scaleTo(neg, -P) : [];
	for (const b of scaled) fixed.set(b.id, b.cents);
	return group.map((b) => ({ id: b.id, cents: fixed.get(b.id) ?? b.cents }));
}

/**
 * Turns final results into cent balances that sum to exactly zero.
 *
 * Each net is converted at `perChip` dollars and rounded with largest remainder so
 * rounding alone can never unbalance the table. If the chips themselves do not sum to
 * zero (a table that ended with an imbalance), the heavier side is trimmed
 * proportionally and `gap` reports by how much, in cents, before trimming.
 */
export function balancesFromResults(
	players: { id: string; stack: number; total_buyin: number }[],
	perChip: number
): { balances: Balance[]; gap: number } {
	const raw = players.map((p) => (p.stack - p.total_buyin) * perChip * 100);
	const gap = Math.round(raw.reduce((a, b) => a + b, 0));
	const cents = apportion(raw, gap);
	const balances = players.map((p, i) => ({ id: p.id, cents: cents[i] }));
	return { balances: gap === 0 ? balances : balanceOut(balances), gap };
}

// Settles one group: first trims it to sum to zero (a no-op for an exact group), then
// repeatedly has the biggest debtor pay the biggest creditor. Every transfer clears at
// least one person and the last clears two, so a group of k needs at most k - 1.
function settleGroup(group: Balance[]): Transfer[] {
	const live = balanceOut(group).filter((b) => b.cents !== 0);
	const creditors = live.filter((b) => b.cents > 0).map((b) => ({ ...b }));
	const debtors = live.filter((b) => b.cents < 0).map((b) => ({ id: b.id, cents: -b.cents }));
	const transfers: Transfer[] = [];
	const byAmount = (a: Balance, b: Balance) => b.cents - a.cents || a.id.localeCompare(b.id);
	while (creditors.length && debtors.length) {
		creditors.sort(byAmount);
		debtors.sort(byAmount);
		const c = creditors[0];
		const d = debtors[0];
		const amount = Math.min(c.cents, d.cents);
		transfers.push({ from: d.id, to: c.id, cents: amount });
		c.cents -= amount;
		d.cents -= amount;
		if (c.cents === 0) creditors.shift();
		if (d.cents === 0) debtors.shift();
	}
	return transfers;
}

function subsetSums(b: Balance[]): Float64Array {
	const sums = new Float64Array(1 << b.length);
	for (let mask = 1; mask < sums.length; mask++) {
		const low = mask & -mask;
		sums[mask] = sums[mask ^ low] + b[31 - Math.clz32(low)].cents;
	}
	return sums;
}

function membersOf(b: Balance[], mask: number): Balance[] {
	return b.filter((_, i) => mask & (1 << i));
}

function finish(balances: Balance[], transfers: Transfer[]): Settlement {
	const got = new Map<string, number>();
	for (const t of transfers) {
		got.set(t.to, (got.get(t.to) ?? 0) + t.cents);
		got.set(t.from, (got.get(t.from) ?? 0) - t.cents);
	}
	const off = balances
		.map((b) => ({ id: b.id, cents: (got.get(b.id) ?? 0) - b.cents }))
		.filter((o) => o.cents !== 0);
	const misallocated = off.reduce((a, o) => a + Math.max(o.cents, 0), 0);
	return { transfers, off, misallocated };
}

/** The fewest transfers that settle every balance exactly. Balances must sum to zero. */
export function settleExact(balances: Balance[]): Settlement {
	const b = balances.filter((x) => x.cents !== 0);
	if (b.length > EXACT_MAX) return finish(balances, settleGroup(b));

	// dp[mask]: the most zero-sum groups `mask` splits into. Peeling players off one
	// at a time and counting every zero-sum prefix along the way reaches the optimum,
	// and the zero-sum masks on the best peeling chain ARE the groups.
	const sums = subsetSums(b);
	const full = (1 << b.length) - 1;
	const dp = new Int8Array(full + 1);
	const peel = new Int8Array(full + 1);
	for (let mask = 1; mask <= full; mask++) {
		let best = -1;
		for (let i = 0; i < b.length; i++) {
			if (!(mask & (1 << i))) continue;
			const v = dp[mask ^ (1 << i)];
			if (v > best) {
				best = v;
				peel[mask] = i;
			}
		}
		dp[mask] = best + (sums[mask] === 0 ? 1 : 0);
	}

	const zeroMasks: number[] = [];
	for (let mask = full; mask; mask ^= 1 << peel[mask]) {
		if (sums[mask] === 0) zeroMasks.push(mask);
	}
	const transfers: Transfer[] = [];
	zeroMasks.forEach((mask, k) => {
		const group = mask & ~(zeroMasks[k + 1] ?? 0);
		transfers.push(...settleGroup(membersOf(b, group)));
	});
	return finish(balances, transfers);
}

// Whole dollars where the tolerance allows it: a transfer of $28.30 becomes $28. Never
// rounds a transfer to nothing, and gives up (keeps the cents) if rounding would push
// the total misallocation past the budget.
function roundToDollars(balances: Balance[], s: Settlement, budget: number): Settlement {
	const rounded = s.transfers.map((t) => ({ ...t, cents: Math.round(t.cents / 100) * 100 }));
	if (rounded.some((t) => t.cents === 0)) return s;
	const r = finish(balances, rounded);
	return r.misallocated <= budget ? r : s;
}

/**
 * The fewest transfers that settle every balance to within `tolerance` of the money
 * that changes hands (the total owed to the winners). Among the ways to reach that
 * count, the one that misallocates least. Balances must sum to zero.
 *
 * A player can be left out entirely (a group of one), which is how a small win or loss
 * stops costing a transfer; groups that do not sum to zero are trimmed proportionally,
 * so a shortfall is shared across a group rather than landing on one person.
 */
export function settleRough(balances: Balance[], tolerance = ROUGH_TOLERANCE): Settlement {
	const b = balances.filter((x) => x.cents !== 0);
	const owed = b.reduce((a, x) => a + Math.max(x.cents, 0), 0);
	// Every unit misallocated shows up twice in the sum of |group sums|: once on the
	// side that is short and once on the side that is over.
	const budget = Math.floor(owed * tolerance);
	if (b.length > ROUGH_MAX) return roundToDollars(balances, settleExact(balances), budget);

	// cost[mask * W + k]: least total |group sum| splitting `mask` into k groups. Each
	// step takes the group holding the lowest remaining player, so each partition is
	// counted once.
	const n = b.length;
	const W = n + 1;
	const sums = subsetSums(b);
	const full = (1 << n) - 1;
	const cost = new Float64Array((full + 1) * W).fill(Infinity);
	const pick = new Int32Array((full + 1) * W);
	cost[0] = 0;
	for (let mask = 1; mask <= full; mask++) {
		const low = mask & -mask;
		const rest = mask ^ low;
		// Every submask of `rest`, each with the lowest player added back in.
		for (let sub = rest; ; sub = (sub - 1) & rest) {
			const group = sub | low;
			const g = Math.abs(sums[group]);
			const remaining = mask ^ group;
			for (let k = 1; k <= n; k++) {
				const prev = cost[remaining * W + k - 1];
				if (prev + g < cost[mask * W + k]) {
					cost[mask * W + k] = prev + g;
					pick[mask * W + k] = group;
				}
			}
			if (sub === 0) break;
		}
	}

	let k = n;
	while (k > 1 && cost[full * W + k] > 2 * budget) k--;
	const transfers: Transfer[] = [];
	for (let mask = full; mask && k > 0; k--) {
		const group = pick[mask * W + k];
		transfers.push(...settleGroup(membersOf(b, group)));
		mask ^= group;
	}
	return roundToDollars(balances, finish(balances, transfers), budget);
}
