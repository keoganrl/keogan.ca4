import { describe, it, expect } from 'vitest';
import { describeEvent } from './ledger';
import type { GameEvent } from '../types';

function event(over: Partial<GameEvent> = {}): GameEvent {
	return {
		id: 'e',
		seq: 1,
		session_id: 'sess',
		player_id: 'p',
		type: 'bet',
		amount: 100,
		street: 'flop',
		target_player_id: null,
		created_at: '',
		...over
	};
}

describe('describeEvent', () => {
	it('tails an all-in action rather than giving it a line of its own', () => {
		expect(describeEvent(event({ type: 'raise', amount: 500, all_in: true }), 'Sam')).toBe(
			'Sam raises to 500 — all in'
		);
		expect(describeEvent(event({ type: 'call', amount: 320, all_in: true }), 'Sam')).toBe(
			'Sam calls 320 — all in'
		);
	});

	it('marks a blind that swallowed the whole stack', () => {
		expect(describeEvent(event({ type: 'post_bb', amount: 30, all_in: true }), 'Sam')).toBe(
			'Sam posts big blind (30) — all in'
		);
	});

	it('leaves ordinary actions alone', () => {
		expect(describeEvent(event({ type: 'bet', amount: 100 }), 'Sam')).toBe('Sam bets 100');
		expect(describeEvent(event({ type: 'fold', amount: null }), 'Sam')).toBe('Sam folds');
	});

	it('never tails an event that renders as nothing', () => {
		// A stray flag on a non-line event must not conjure a bare "— all in" into the log.
		expect(describeEvent(event({ type: 'deal', all_in: true }), 'Sam')).toBe('');
		expect(describeEvent(event({ type: 'street', all_in: true }), 'Sam')).toBe('');
	});
});
