import { describe, it, expect } from 'vitest';
import { buildNetSeries, niceScale, seriesPath, SERIES_COLORS } from './netSeries';
import type { SessionResult } from '../types';

let seq = 0;
function row(
	identity: string,
	session: string,
	net: number,
	over: Partial<SessionResult> = {}
): SessionResult {
	seq += 1;
	return {
		identity_id: identity,
		display_name: identity,
		session_id: session,
		// Distinct, ordered timestamps unless a test overrides them.
		created_at: `2026-01-${String(session.length + 1).padStart(2, '0')}T00:00:0${seq % 10}Z`,
		big_blind: 2,
		net,
		net_bb: net / 2,
		...over
	};
}

describe('buildNetSeries', () => {
	it('accumulates each player across sessions in chronological order', () => {
		const rows = [
			row('ada', 'a', 100, { created_at: '2026-01-01T00:00:00Z' }),
			row('ada', 'b', -30, { created_at: '2026-01-02T00:00:00Z' }),
			row('bo', 'a', -100, { created_at: '2026-01-01T00:00:00Z' }),
			row('bo', 'b', 30, { created_at: '2026-01-02T00:00:00Z' })
		];
		const data = buildNetSeries(rows);
		expect(data.sessionIds).toEqual(['a', 'b']);
		const ada = data.series.find((s) => s.identityId === 'ada')!;
		const bo = data.series.find((s) => s.identityId === 'bo')!;
		// index 0 is the shared pre-game zero
		expect(ada.points).toEqual([0, 100, 70]);
		expect(bo.points).toEqual([0, -100, -70]);
		expect(ada.total).toBe(70);
	});

	it('orders sessions by date, not by the order rows arrived', () => {
		const rows = [
			row('ada', 'later', 5, { created_at: '2026-03-01T00:00:00Z' }),
			row('ada', 'earlier', 50, { created_at: '2026-01-01T00:00:00Z' })
		];
		const data = buildNetSeries(rows);
		expect(data.sessionIds).toEqual(['earlier', 'later']);
		expect(data.series[0].points).toEqual([0, 50, 55]);
	});

	it('carries a total flat through sessions a player sat out', () => {
		const rows = [
			row('ada', 'a', 100, { created_at: '2026-01-01T00:00:00Z' }),
			row('bo', 'a', -100, { created_at: '2026-01-01T00:00:00Z' }),
			// only bo plays session b
			row('bo', 'b', 40, { created_at: '2026-01-02T00:00:00Z' }),
			row('ada', 'c', 10, { created_at: '2026-01-03T00:00:00Z' }),
			row('bo', 'c', -10, { created_at: '2026-01-03T00:00:00Z' })
		];
		const ada = buildNetSeries(rows).series.find((s) => s.identityId === 'ada')!;
		// unchanged across session b, then moves again at c
		expect(ada.points).toEqual([0, 100, 100, 110]);
	});

	it('starts a late debut at zero and records where their history begins', () => {
		const rows = [
			row('ada', 'a', 100, { created_at: '2026-01-01T00:00:00Z' }),
			row('late', 'b', -20, { created_at: '2026-01-02T00:00:00Z' })
		];
		const late = buildNetSeries(rows).series.find((s) => s.identityId === 'late')!;
		expect(late.firstIndex).toBe(1);
		expect(late.points).toEqual([0, 0, -20]);
	});

	it('assigns colour by debut order, not by rank', () => {
		// bo debuts first but finishes last; ada debuts second but wins.
		const rows = [
			row('bo', 'a', -500, { created_at: '2026-01-01T00:00:00Z' }),
			row('ada', 'b', 900, { created_at: '2026-01-02T00:00:00Z' })
		];
		const data = buildNetSeries(rows);
		const bo = data.series.find((s) => s.identityId === 'bo')!;
		const ada = data.series.find((s) => s.identityId === 'ada')!;
		expect(bo.color).toBe(SERIES_COLORS[0]);
		expect(ada.color).toBe(SERIES_COLORS[1]);
	});

	it('keeps a colour stable when a later session changes the ranking', () => {
		const first = [
			row('bo', 'a', -500, { created_at: '2026-01-01T00:00:00Z' }),
			row('ada', 'a', 500, { created_at: '2026-01-01T00:00:00Z' })
		];
		const before = buildNetSeries(first);
		// A blowout reverses the standings entirely.
		const after = buildNetSeries([
			...first,
			row('bo', 'b', 5000, { created_at: '2026-02-01T00:00:00Z' }),
			row('ada', 'b', -5000, { created_at: '2026-02-01T00:00:00Z' })
		]);
		const colorOf = (d: ReturnType<typeof buildNetSeries>, id: string) =>
			d.series.find((s) => s.identityId === id)!.color;
		expect(colorOf(after, 'bo')).toBe(colorOf(before, 'bo'));
		expect(colorOf(after, 'ada')).toBe(colorOf(before, 'ada'));
	});

	it('dashes the ninth player onward, where the palette repeats', () => {
		const rows = Array.from({ length: 10 }, (_, i) =>
			row(`p${String(i).padStart(2, '0')}`, 'a', i, { created_at: '2026-01-01T00:00:00Z' })
		);
		const data = buildNetSeries(rows);
		expect(data.series.slice(0, 8).every((s) => !s.dashed)).toBe(true);
		expect(data.series[8].dashed).toBe(true);
		expect(data.series[8].color).toBe(SERIES_COLORS[0]);
	});

	it('reports the running min and max across every line', () => {
		const rows = [
			row('ada', 'a', 100, { created_at: '2026-01-01T00:00:00Z' }),
			row('ada', 'b', -400, { created_at: '2026-01-02T00:00:00Z' }),
			row('bo', 'a', 250, { created_at: '2026-01-01T00:00:00Z' })
		];
		const data = buildNetSeries(rows);
		expect(data.max).toBe(250);
		expect(data.min).toBe(-300);
	});

	it('returns an empty chart rather than throwing on no sessions', () => {
		const data = buildNetSeries([]);
		expect(data.series).toEqual([]);
		expect(data.sessionIds).toEqual([]);
	});
});

describe('niceScale', () => {
	it('always spans zero so the break-even line is on the chart', () => {
		const up = niceScale(200, 900);
		expect(up.min).toBe(0);
		expect(up.ticks).toContain(0);
		const down = niceScale(-900, -200);
		expect(down.max).toBe(0);
		expect(down.ticks).toContain(0);
	});

	it('lands on round ticks that cover the data', () => {
		const s = niceScale(-320, 880);
		expect(s.min).toBeLessThanOrEqual(-320);
		expect(s.max).toBeGreaterThanOrEqual(880);
		expect(s.ticks[0]).toBe(s.min);
		expect(s.ticks[s.ticks.length - 1]).toBe(s.max);
	});

	it('does not emit float drift in its tick labels', () => {
		// A naive accumulator produces -1.3877787807814457e-17 instead of 0 here.
		for (const t of niceScale(-0.5, 0.5).ticks) {
			expect(String(t)).not.toMatch(/e-/);
		}
	});

	it('survives a flat all-zero board', () => {
		const s = niceScale(0, 0);
		expect(s.ticks).toContain(0);
		expect(s.max).toBeGreaterThan(s.min);
	});
});

describe('seriesPath', () => {
	it('draws only from the player’s debut onward', () => {
		const rows = [
			row('ada', 'a', 100, { created_at: '2026-01-01T00:00:00Z' }),
			row('late', 'b', -20, { created_at: '2026-01-02T00:00:00Z' })
		];
		const data = buildNetSeries(rows);
		const late = data.series.find((s) => s.identityId === 'late')!;
		const scale = niceScale(data.min, data.max);
		const pts = seriesPath(late, scale, 200, 100, data.sessionIds.length).split(' ');
		// debut at index 1 of 2 sessions: starts halfway across, not at the left edge
		expect(pts).toHaveLength(2);
		expect(Number(pts[0].split(',')[0])).toBeCloseTo(100);
	});

	it('puts a higher total higher on the canvas', () => {
		const rows = [
			row('win', 'a', 100, { created_at: '2026-01-01T00:00:00Z' }),
			row('lose', 'a', -100, { created_at: '2026-01-01T00:00:00Z' })
		];
		const data = buildNetSeries(rows);
		const scale = niceScale(data.min, data.max);
		const yOf = (id: string) => {
			const s = data.series.find((x) => x.identityId === id)!;
			const last = seriesPath(s, scale, 200, 100, data.sessionIds.length).split(' ').pop()!;
			return Number(last.split(',')[1]);
		};
		// SVG y grows downward, so the winner's y must be the smaller number.
		expect(yOf('win')).toBeLessThan(yOf('lose'));
	});
});
