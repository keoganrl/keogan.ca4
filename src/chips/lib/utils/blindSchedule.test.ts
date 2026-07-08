import { describe, it, expect } from 'vitest';
import { generateCashEscalationSchedule, generateTournamentSchedule } from './blindSchedule';

describe('blind schedules climb in multiples of the starting blinds', () => {
	it('cash escalation ladder is start × 1, 2, 3, …', () => {
		const schedule = generateCashEscalationSchedule(1000, 120);
		const [sb0, bb0] = [schedule[0].small_blind, schedule[0].big_blind];
		expect(schedule[0]).toMatchObject({ small_blind: 10, big_blind: 20 });
		schedule.forEach((level, i) => {
			expect(level.small_blind).toBe(sb0 * (i + 1));
			expect(level.big_blind).toBe(bb0 * (i + 1));
		});
	});

	it('tournament schedule uses the same multiples', () => {
		const schedule = generateTournamentSchedule(1000, 6, 120, 'normal');
		const bb0 = schedule[0].big_blind;
		schedule.forEach((level, i) => {
			expect(level.big_blind).toBe(bb0 * (i + 1));
		});
	});

	it('big blind stays exactly 2× the small blind at every level', () => {
		for (const mins of [60, 120, 180, 240] as const) {
			for (const level of generateCashEscalationSchedule(1000, mins)) {
				expect(level.big_blind).toBe(level.small_blind * 2);
			}
		}
	});
});
