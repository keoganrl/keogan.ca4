import { describe, it, expect } from 'vitest';
import { generateCashEscalationSchedule, generateTournamentSchedule } from './blindSchedule';

describe('blind schedules double every rung', () => {
	it('cash escalation ladder doubles from the suggested start', () => {
		const schedule = generateCashEscalationSchedule(1000, 120);
		expect(schedule[0]).toMatchObject({ small_blind: 10, big_blind: 20 });
		for (let i = 1; i < schedule.length; i++) {
			expect(schedule[i].small_blind).toBe(schedule[i - 1].small_blind * 2);
			expect(schedule[i].big_blind).toBe(schedule[i - 1].big_blind * 2);
		}
	});

	it('tournament schedule doubles too', () => {
		const schedule = generateTournamentSchedule(1000, 6, 120, 'normal');
		for (let i = 1; i < schedule.length; i++) {
			expect(schedule[i].big_blind).toBe(schedule[i - 1].big_blind * 2);
		}
	});

	it('big blind stays exactly 2× the small blind at every level', () => {
		for (const mins of [60, 120, 180, 240] as const) {
			for (const level of generateCashEscalationSchedule(1000, mins)) {
				expect(level.big_blind).toBe(level.small_blind * 2);
			}
		}
	});
});
