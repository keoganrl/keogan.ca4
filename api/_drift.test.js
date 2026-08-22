import { describe, it, expect } from 'vitest';
import { needsRewrite, selectForRewrite, snapshotOf, THRESHOLDS } from './_drift.js';

const snap = (over = {}) => ({ vpip_pct: 45, pfr_pct: 20, wtsd_pct: 40, af: 1.2, ...over });

describe('needsRewrite', () => {
	it('rewrites when there is no snapshot to compare against', () => {
		expect(needsRewrite(snap(), null)).toBe(true);
	});

	it('leaves a player alone when nothing moved', () => {
		expect(needsRewrite(snap(), snap())).toBe(false);
	});

	it('ignores drift that stays inside the threshold', () => {
		expect(needsRewrite(snap({ vpip_pct: 50 }), snap())).toBe(false);
		expect(needsRewrite(snap({ af: 1.5 }), snap())).toBe(false);
	});

	it('rewrites once a figure moves past it', () => {
		expect(needsRewrite(snap({ vpip_pct: 50.1 }), snap())).toBe(true);
		expect(needsRewrite(snap({ af: 1.51 }), snap())).toBe(true);
	});

	it('reads movement in either direction', () => {
		expect(needsRewrite(snap({ pfr_pct: 4 }), snap())).toBe(true);
	});

	// A null is an absence, not a zero — treating it as 0 would report a 45-point
	// swing the first time a player records a figure they simply had none of before.
	it('treats gaining a figure as news, and two absences as none', () => {
		expect(needsRewrite(snap({ af: 0.9 }), snap({ af: null }))).toBe(true);
		expect(needsRewrite(snap({ af: null }), snap({ af: null }))).toBe(false);
	});

	it('watches every threshold, not just the first', () => {
		for (const key of Object.keys(THRESHOLDS)) {
			const current = snap({ [key]: snap()[key] + THRESHOLDS[key] + 1 });
			expect(needsRewrite(current, snap()), key).toBe(true);
		}
	});
});

describe('selectForRewrite', () => {
	const stats = [
		{ identity_id: 'a', ...snap() },
		{ identity_id: 'b', ...snap({ vpip_pct: 70 }) },
		{ identity_id: 'c', ...snap() }
	];

	it('picks only players who both played and moved', () => {
		const profiles = [
			{ identity_id: 'a', profile: 'x', stats_snapshot: snap() },
			{ identity_id: 'b', profile: 'y', stats_snapshot: snap() },
			{ identity_id: 'c', profile: 'z', stats_snapshot: snap() }
		];
		expect(selectForRewrite({ stats, profiles, participantIds: ['a', 'b'] })).toEqual(['b']);
	});

	it('picks nobody on a night that changed nothing', () => {
		const profiles = stats.map((s) => ({
			identity_id: s.identity_id,
			profile: 'x',
			stats_snapshot: snapshotOf(s)
		}));
		expect(selectForRewrite({ stats, profiles, participantIds: ['a', 'b', 'c'] })).toEqual([]);
	});

	it('always picks a player who has no profile yet', () => {
		const profiles = [{ identity_id: 'a', profile: 'x', stats_snapshot: snap() }];
		expect(selectForRewrite({ stats, profiles, participantIds: ['a', 'c'] })).toEqual(['c']);
	});

	it('picks a player whose row exists but whose text is empty', () => {
		const profiles = [{ identity_id: 'a', profile: '', stats_snapshot: snap() }];
		expect(selectForRewrite({ stats, profiles, participantIds: ['a'] })).toEqual(['a']);
	});

	// The guard that matters: if the VIEW's arithmetic is ever corrected, everyone's
	// numbers shift at once. Without the participant gate that would rewrite the
	// whole table in one night; with it, each profile catches up as its player next
	// sits down.
	it('never rewrites someone who did not play, however far their numbers moved', () => {
		const profiles = [
			{ identity_id: 'b', profile: 'y', stats_snapshot: snap({ vpip_pct: 5, af: 0.1 }) }
		];
		expect(selectForRewrite({ stats, profiles, participantIds: ['a'] })).not.toContain('b');
	});
});

describe('snapshotOf', () => {
	it('keeps exactly the compared fields, normalising absent ones to null', () => {
		const s = snapshotOf({ identity_id: 'a', vpip_pct: 45, pfr_pct: 20, wtsd_pct: 40, hands: 300 });
		expect(s).toEqual({ vpip_pct: 45, pfr_pct: 20, wtsd_pct: 40, af: null });
	});
});
