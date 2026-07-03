import type { Player } from '$lib/types';

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
