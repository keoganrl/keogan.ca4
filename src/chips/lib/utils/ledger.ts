import type { GameEvent } from '../types';

export interface HandGroup {
	// 0 = pre-game "Lobby" (events before the first deal); 1+ = hand number
	hand: number;
	events: GameEvent[];
}

/**
 * Splits a chronological event list into per-hand groups. Each `deal` event marks a
 * hand boundary and is consumed (never rendered as a line). Events that occur before
 * the first deal — e.g. players joining during setup — form a leading "Lobby" group.
 * Empty groups are dropped.
 */
export function groupEventsByHand(events: GameEvent[]): HandGroup[] {
	const groups: HandGroup[] = [];
	let hand = 0;
	let current: HandGroup | null = null;

	for (const e of events) {
		if (e.type === 'deal') {
			hand += 1;
			current = { hand, events: [] };
			groups.push(current);
			continue;
		}
		if (!current) {
			current = { hand: 0, events: [] };
			groups.push(current);
		}
		current.events.push(e);
	}

	return groups.filter((g) => g.events.length > 0);
}

const STREET_LABEL: Record<string, string> = {
	preflop: 'Preflop',
	flop: 'Flop',
	turn: 'Turn',
	river: 'River',
	showdown: 'Showdown'
};

/** Display label for a `street` event (e.g. "Flop"), rendered as a divider. */
export function streetLabel(street: string | null): string {
	if (!street) return '';
	return STREET_LABEL[street] ?? street.charAt(0).toUpperCase() + street.slice(1);
}

/**
 * Human-readable line for a single event, given the actor's display name. Returns ''
 * for events that aren't rendered as lines (`deal`, and `street` which is a divider).
 */
export function describeEvent(event: GameEvent, name: string): string {
	const amt = event.amount ?? 0;
	switch (event.type) {
		case 'post_sb':
			return `${name} posts small blind (${amt})`;
		case 'post_bb':
			return `${name} posts big blind (${amt})`;
		case 'bet':
			return `${name} bets ${amt}`;
		case 'raise':
			return `${name} raises to ${amt}`;
		case 'call':
			return `${name} calls ${amt}`;
		case 'check':
			return `${name} checks`;
		case 'fold':
			return `${name} folds`;
		case 'win':
			return `${name} wins ${amt}`;
		case 'rebuy':
			return `${name} rebuys ${amt}`;
		case 'join':
			return `${name} joined`;
		case 'leave':
			return `${name} left`;
		case 'kick':
			return `${name} was kicked`;
		case 'deal':
		case 'street':
			return '';
		default:
			return '';
	}
}
