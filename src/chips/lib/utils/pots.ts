import type { Player } from '../types';

export type Pot = { amount: number; eligibleIds: string[] };

function sameEligibleSet(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const sa = [...a].sort();
	const sb = [...b].sort();
	return sa.every((id, i) => id === sb[i]);
}

/**
 * Computes the pot structure from player contributions.
 *
 * Standard poker side-pot algorithm: walk up contribution levels in ascending
 * order. At each level, the pot slice = (level delta) × (# contributors who
 * reached that level). Eligible players for each slice are the non-folded,
 * active players whose hand_total_bet >= that level. Folded players' chips
 * are included in pot sizes but they cannot win.
 *
 * Adjacent pots with identical eligible sets are merged — this handles the
 * common case where a folded player's contribution creates a separate level
 * but all surviving players are eligible for both slices.
 */
export function computePots(players: Player[]): Pot[] {
	const contributors = players.filter((p) => p.hand_total_bet > 0);
	if (!contributors.length) return [];

	const eligible = players.filter((p) => !p.folded && p.is_active);

	const sorted = [...contributors].sort((a, b) => a.hand_total_bet - b.hand_total_bet);
	const levels = [...new Set(sorted.map((p) => p.hand_total_bet))];

	const pots: Pot[] = [];
	let prev = 0;

	for (const level of levels) {
		const atLevel = contributors.filter((p) => p.hand_total_bet >= level);
		const potAmount = (level - prev) * atLevel.length;
		const eligibleForPot = eligible.filter((p) => p.hand_total_bet >= level);

		if (potAmount > 0) {
			if (eligibleForPot.length > 0) {
				pots.push({ amount: potAmount, eligibleIds: eligibleForPot.map((p) => p.id) });
			} else if (pots.length > 0) {
				// All eligible players already covered at a lower level — add to last pot
				pots[pots.length - 1].amount += potAmount;
			}
		}
		prev = level;
	}

	// Merge adjacent pots that have the same eligible set — they go to the same winner
	// and should be presented as one pot to the host.
	const merged: Pot[] = [];
	for (const pot of pots) {
		const last = merged[merged.length - 1];
		if (last && sameEligibleSet(last.eligibleIds, pot.eligibleIds)) {
			last.amount += pot.amount;
		} else {
			merged.push({ amount: pot.amount, eligibleIds: [...pot.eligibleIds] });
		}
	}
	return merged;
}

export type AwardResolution = {
	// chips each winner takes this round (sums exactly to the consumed pots)
	payouts: Record<string, number>;
	// pots none of the confirmed winners were eligible for — resolved in a later round
	remainingPots: Pot[];
};

/**
 * Resolves one "who had the best hand?" answer against the outstanding pots.
 *
 * The confirmed winner(s) take every remaining pot they're eligible for; ties split
 * each pot equally among the tied winners eligible for it. Integer shares only — odd
 * chips go one each to the tied winners in seat order starting left of the button
 * (the standard odd-chip rule, and deterministic).
 *
 * Pots the winners can't reach (deeper side pots when the best hand was all-in for
 * less) are returned in remainingPots for the host's next question. Because
 * computePots orders pots main → side with nested eligibility, `remainingPots[0]`
 * always holds the widest candidate set for that next question.
 */
export function resolveAward(
	remainingPots: Pot[],
	winnerIds: string[],
	players: Player[],
	buttonPlayerId: string | null
): AwardResolution {
	const payouts: Record<string, number> = {};
	const leftover: Pot[] = [];

	// Rank players by seat, starting one left of the button, for odd-chip order.
	const bySeat = [...players].sort((a, b) => a.seat_order - b.seat_order);
	const btnIdx = bySeat.findIndex((p) => p.id === buttonPlayerId);
	const oddChipRank = new Map<string, number>(
		bySeat.map((_, i) => [bySeat[(btnIdx + 1 + i) % bySeat.length].id, i])
	);

	for (const pot of remainingPots) {
		const winners = winnerIds.filter((id) => pot.eligibleIds.includes(id));
		if (!winners.length) {
			leftover.push(pot);
			continue;
		}
		const ordered = [...winners].sort(
			(a, b) => (oddChipRank.get(a) ?? Infinity) - (oddChipRank.get(b) ?? Infinity)
		);
		const share = Math.floor(pot.amount / ordered.length);
		let remainder = pot.amount - share * ordered.length;
		for (const id of ordered) {
			payouts[id] = (payouts[id] ?? 0) + share + (remainder > 0 ? 1 : 0);
			if (remainder > 0) remainder--;
		}
	}

	return { payouts, remainingPots: leftover };
}
