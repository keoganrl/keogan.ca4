import type { BlindLevel } from '../types';

export type Pace = 'turbo' | 'normal' | 'deep';
export type CashSessionLength = 60 | 120 | 180 | 240;

const NICE_BLINDS: [number, number][] = [
	[1, 2],
	[2, 4],
	[2, 5],
	[3, 6],
	[5, 10],
	[10, 20],
	[15, 30],
	[25, 50],
	[50, 100],
	[75, 150],
	[100, 200],
	[200, 400],
	[300, 600],
	[500, 1000]
];

// Shorter sessions get shallower effective stacks (bigger blinds) so games actually
// resolve in the time available: a 1-hour session starts everyone at ~20 big blinds.
const CASH_SESSION_TARGET_BB: Record<CashSessionLength, number> = {
	60: 20,
	120: 50,
	180: 75,
	240: 100
};

function suggestStartingIndex(buyIn: number, targetBBMultiplier = 75): number {
	const targetBB = buyIn / targetBBMultiplier;
	let best = 0;
	for (let i = 0; i < NICE_BLINDS.length; i++) {
		if (NICE_BLINDS[i][1] <= targetBB) best = i;
	}
	return best;
}

export function suggestCashBlinds(
	buyIn: number,
	sessionMinutes: CashSessionLength = 120
): [number, number] {
	const idx = suggestStartingIndex(buyIn, CASH_SESSION_TARGET_BB[sessionMinutes]);
	return NICE_BLINDS[idx];
}

// Levels strictly double from the starting blinds. NICE_BLINDS only picks the
// start; stepping through it gave sub-2× jumps (25/50 → 50/100 → 75/150) that
// played as barely-rising blinds over a whole session.
function doubledBlinds(start: [number, number], level: number): [number, number] {
	return [start[0] * 2 ** level, start[1] * 2 ** level];
}

const PACE_MINUTES: Record<Pace, number> = {
	turbo: 10,
	normal: 20,
	deep: 30
};

export function generateTournamentSchedule(
	buyIn: number,
	numPlayers: number,
	sessionMinutes: number,
	pace: Pace
): BlindLevel[] {
	const start = NICE_BLINDS[suggestStartingIndex(buyIn)];
	const levelMinutes = PACE_MINUTES[pace];
	const totalLevels = Math.max(3, Math.round(sessionMinutes / levelMinutes));

	return Array.from({ length: totalLevels }, (_, i) => {
		const [sb, bb] = doubledBlinds(start, i);
		return { level: i + 1, small_blind: sb, big_blind: bb, duration_minutes: levelMinutes };
	});
}

// The ladder starts at the same blinds the session length suggests, then escalates.
// A fixed nine-step ladder covers any table size (3 to 9 players): blinds only ever
// climb as seats empty, so extra rungs simply go unused at a small table.
export function generateCashEscalationSchedule(
	buyIn: number,
	sessionMinutes: CashSessionLength = 120,
	steps = 9
): BlindLevel[] {
	const start = NICE_BLINDS[suggestStartingIndex(buyIn, CASH_SESSION_TARGET_BB[sessionMinutes])];

	return Array.from({ length: steps }, (_, i) => {
		const [sb, bb] = doubledBlinds(start, i);
		return { level: i + 1, small_blind: sb, big_blind: bb, duration_minutes: 0 };
	});
}

export function formatBlindTime(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${m}:${String(s).padStart(2, '0')}`;
}
