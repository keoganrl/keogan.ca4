import { describe, it, expect } from 'vitest';
import { statSections, confidenceOf } from './playerStats';
import type { PlayerStat } from '../types';

// A fully-populated row; individual tests blank out the fields they care about.
function stat(over: Partial<PlayerStat> = {}): PlayerStat {
	return {
		identity_id: 'p1',
		display_name: 'Player One',
		hands: 300,
		reliability: 'ok',
		vpip_pct: 24.5,
		pfr_pct: 18,
		vpip_pfr_gap: 6.5,
		af: 2.4,
		cbet_flop_pct: 65,
		cbet_opps: 40,
		fold_to_cbet_pct: 42,
		faced_cbet_opps: 35,
		steal_pct: 30,
		steal_opps: 50,
		fold_to_steal_pct: 70,
		faced_steal_opps: 45,
		wtsd_pct: 27,
		saw_flop_hands: 120,
		vpip_early_pct: 15,
		early_hands: 90,
		vpip_late_pct: 35,
		late_hands: 100,
		vpip_blinds_pct: 40,
		blind_hands: 80,
		chips_won: 5000,
		biggest_pot: 900,
		...over
	};
}

function findRow(sections: ReturnType<typeof statSections>, label: string) {
	return sections.flatMap((s) => s.rows).find((r) => r.label === label);
}

describe('confidenceOf', () => {
	it('grades by how many spots the figure was measured over', () => {
		expect(confidenceOf(30)).toBe('ok');
		expect(confidenceOf(29)).toBe('thin');
		expect(confidenceOf(10)).toBe('thin');
		expect(confidenceOf(9)).toBe('anecdote');
		expect(confidenceOf(0)).toBe('anecdote');
	});
});

describe('statSections', () => {
	it('groups a full row into three sections', () => {
		const sections = statSections(stat());
		expect(sections.map((s) => s.title)).toEqual([
			'How often you play',
			'How you play',
			'Where you play from'
		]);
	});

	it('formats percentages and the aggression factor differently', () => {
		const sections = statSections(stat());
		expect(findRow(sections, 'VPIP')?.value).toBe('24.5%');
		expect(findRow(sections, 'Aggression factor')?.value).toBe('2.40');
	});

	// The whole point of the panel: a percentage measured over three spots must not
	// look like one measured over three hundred.
	it('grades each figure on its own denominator, not the hand count', () => {
		const sections = statSections(stat({ hands: 500, faced_cbet_opps: 3, fold_to_cbet_pct: 100 }));
		const row = findRow(sections, 'Fold to c-bet');
		expect(row?.value).toBe('100%');
		expect(row?.confidence).toBe('anecdote');
		expect(row?.basis).toBe('3 spots');
		// …while a well-sampled figure on the same row set stays trustworthy.
		expect(findRow(sections, 'C-bet')?.confidence).toBe('ok');
	});

	it('singularises the basis for a lone spot', () => {
		const sections = statSections(stat({ faced_cbet_opps: 1 }));
		expect(findRow(sections, 'Fold to c-bet')?.basis).toBe('1 spot');
	});

	// A metric you never had the chance to record is an absence, not a zero.
	it('drops rows the view could not compute', () => {
		const sections = statSections(stat({ steal_pct: null, steal_opps: 0 }));
		expect(findRow(sections, 'Steal')).toBeUndefined();
		// The rest of that section survives.
		expect(findRow(sections, 'C-bet')).toBeDefined();
	});

	it('drops a section once every row in it is missing', () => {
		const sections = statSections(
			stat({
				vpip_early_pct: null,
				vpip_late_pct: null,
				vpip_blinds_pct: null,
				wtsd_pct: null
			})
		);
		expect(sections.map((s) => s.title)).not.toContain('Where you play from');
	});

	it('returns nothing at all for a player with no computable figures', () => {
		const empty = stat({
			vpip_pct: null,
			pfr_pct: null,
			vpip_pfr_gap: null,
			af: null,
			cbet_flop_pct: null,
			fold_to_cbet_pct: null,
			steal_pct: null,
			fold_to_steal_pct: null,
			wtsd_pct: null,
			vpip_early_pct: null,
			vpip_late_pct: null,
			vpip_blinds_pct: null
		});
		expect(statSections(empty)).toEqual([]);
	});

	it('carries a plain-language hint on every row it keeps', () => {
		for (const row of statSections(stat()).flatMap((s) => s.rows)) {
			expect(row.hint.length).toBeGreaterThan(0);
		}
	});
});
