import type { PlayerStat } from '../types';

/**
 * How much weight a figure can carry, judged from the number of spots it was
 * measured over — not from the player's total hands. A regular with 400 hands
 * can still have faced only three c-bets, and "folds to c-bets 100%" off three
 * spots is noise wearing a percentage's clothes.
 */
export type Confidence = 'ok' | 'thin' | 'anecdote';

// Opportunity counts, not hands: these thresholds apply to denominators like
// "times you faced a c-bet". The hands-based thresholds in the view itself are
// higher because every hand contributes to VPIP, while only some contribute here.
const OK_SPOTS = 30;
const THIN_SPOTS = 10;

export function confidenceOf(denominator: number): Confidence {
	if (denominator >= OK_SPOTS) return 'ok';
	if (denominator >= THIN_SPOTS) return 'thin';
	return 'anecdote';
}

export interface StatRow {
	label: string;
	/** Formatted for display, or null when there is nothing to show at all. */
	value: string | null;
	/** The denominator in words, e.g. '18 spots' — what the percentage is out of. */
	basis: string;
	confidence: Confidence;
	/** One line explaining what the figure means, for people who don't speak poker. */
	hint: string;
}

export interface StatSection {
	title: string;
	rows: StatRow[];
}

function pct(value: number | null): string | null {
	return value === null || value === undefined ? null : `${value}%`;
}

function spots(n: number, noun = 'spot'): string {
	return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Groups a player_stats row into the three questions people actually ask of these
 * numbers: how often you play, how you play once you're in, and how it ends.
 * Rows whose denominator is zero are dropped entirely — a metric you have never
 * had the chance to record is not a zero, it is an absence, and showing it as
 * '0%' is the single most misleading thing this panel could do.
 */
export function statSections(s: PlayerStat): StatSection[] {
	const sections: StatSection[] = [
		{
			title: 'How often you play',
			rows: [
				{
					label: 'VPIP',
					value: pct(s.vpip_pct),
					basis: spots(s.hands, 'hand'),
					confidence: s.reliability,
					hint: 'Share of hands you put money in voluntarily'
				},
				{
					label: 'PFR',
					value: pct(s.pfr_pct),
					basis: spots(s.hands, 'hand'),
					confidence: s.reliability,
					hint: 'Share of hands you raised before the flop'
				},
				{
					label: 'Gap',
					value: pct(s.vpip_pfr_gap),
					basis: spots(s.hands, 'hand'),
					confidence: s.reliability,
					hint: 'How much more you call than raise — a wide gap means passive'
				}
			]
		},
		{
			title: 'How you play',
			rows: [
				{
					label: 'Aggression factor',
					value: s.af === null ? null : s.af.toFixed(2),
					basis: spots(s.hands, 'hand'),
					confidence: s.reliability,
					hint: 'Bets and raises for every call you make'
				},
				{
					label: 'C-bet',
					value: pct(s.cbet_flop_pct),
					basis: spots(s.cbet_opps),
					confidence: confidenceOf(s.cbet_opps),
					hint: 'How often you follow your preflop raise with a flop bet'
				},
				{
					label: 'Fold to c-bet',
					value: pct(s.fold_to_cbet_pct),
					basis: spots(s.faced_cbet_opps),
					confidence: confidenceOf(s.faced_cbet_opps),
					hint: 'How often you give up when the preflop raiser bets the flop'
				},
				{
					label: 'Steal',
					value: pct(s.steal_pct),
					basis: spots(s.steal_opps),
					confidence: confidenceOf(s.steal_opps),
					hint: 'How often you attack the blinds from late position'
				},
				{
					label: 'Fold to steal',
					value: pct(s.fold_to_steal_pct),
					basis: spots(s.faced_steal_opps),
					confidence: confidenceOf(s.faced_steal_opps),
					hint: 'How often you surrender your blind to a late-position raise'
				}
			]
		},
		{
			title: 'Where you play from',
			rows: [
				{
					label: 'VPIP early',
					value: pct(s.vpip_early_pct),
					basis: spots(s.early_hands, 'hand'),
					confidence: confidenceOf(s.early_hands),
					hint: 'How often you play from the first seats to act'
				},
				{
					label: 'VPIP late',
					value: pct(s.vpip_late_pct),
					basis: spots(s.late_hands, 'hand'),
					confidence: confidenceOf(s.late_hands),
					hint: 'How often you play from the last seats to act'
				},
				{
					label: 'VPIP blinds',
					value: pct(s.vpip_blinds_pct),
					basis: spots(s.blind_hands, 'hand'),
					confidence: confidenceOf(s.blind_hands),
					hint: 'How often you defend once you have posted'
				},
				{
					label: 'Went to showdown',
					value: pct(s.wtsd_pct),
					basis: spots(s.saw_flop_hands, 'flop'),
					confidence: confidenceOf(s.saw_flop_hands),
					hint: 'How often seeing a flop ends with you showing cards'
				}
			]
		}
	];

	// A row with no value has no denominator behind it either; keep sections that
	// still say something and drop the rest, so the panel never renders an empty box.
	return sections
		.map((section) => ({ ...section, rows: section.rows.filter((r) => r.value !== null) }))
		.filter((section) => section.rows.length > 0);
}
