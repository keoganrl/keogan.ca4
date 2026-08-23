import { describe, it, expect } from 'vitest';
import { facingShortAllIn, minRaiseTotal } from './betting';
import type { GameEvent } from '../types';

let seq = 0;
function event(over: Partial<GameEvent> = {}): GameEvent {
	seq += 1;
	return {
		id: `e${seq}`,
		seq,
		session_id: 'S',
		player_id: 'p',
		type: 'raise',
		amount: null,
		street: 'flop',
		target_player_id: null,
		all_in: false,
		created_at: '',
		...over
	};
}

const deal = () => event({ type: 'deal', street: null });
const raise = (amount: number, allIn = false) => event({ type: 'raise', amount, all_in: allIn });
const bet = (amount: number, allIn = false) => event({ type: 'bet', amount, all_in: allIn });

const session = { street: 'flop', big_blind: 20 };

describe('minRaiseTotal', () => {
	it('doubles the current bet', () => {
		expect(minRaiseTotal({ current_bet: 100, big_blind: 20 })).toBe(200);
	});

	it('opens at the big blind when there is no bet yet', () => {
		expect(minRaiseTotal({ current_bet: 0, big_blind: 20 })).toBe(20);
	});
});

describe('facingShortAllIn', () => {
	it('is false when nobody has bet this street', () => {
		expect(facingShortAllIn([deal()], session)).toBe(false);
	});

	it('is false for an ordinary raise', () => {
		expect(facingShortAllIn([deal(), bet(100), raise(300)], session)).toBe(false);
	});

	// The whole point: 130 over a 100 bet is not a full raise (which would be 200), so
	// the players who already called 100 owe 30 and nothing more.
	it('is true for an all-in that falls short of a full raise', () => {
		expect(facingShortAllIn([deal(), bet(100), raise(130, true)], session)).toBe(true);
	});

	it('is false for an all-in that clears a full raise', () => {
		expect(facingShortAllIn([deal(), bet(100), raise(250, true)], session)).toBe(false);
	});

	// An all-in exactly at the minimum is a full raise, so it reopens the betting.
	it('is false for an all-in exactly at the minimum', () => {
		expect(facingShortAllIn([deal(), bet(100), raise(200, true)], session)).toBe(false);
	});

	// Once somebody makes a real raise over the short shove, everyone can play again.
	it('stops applying once a full raise lands on top', () => {
		const events = [deal(), bet(100), raise(130, true), raise(400)];
		expect(facingShortAllIn(events, session)).toBe(false);
	});

	// Blinds are logged without a street, so preflop the big blind is the level an
	// opening raise has to double. A shove to 30 over a 20 blind is short.
	it('measures a preflop shove against the big blind', () => {
		const preflop = { street: 'preflop', big_blind: 20 };
		const shove = (amount: number) =>
			event({ type: 'raise', amount, all_in: true, street: 'preflop' });
		expect(facingShortAllIn([deal(), shove(30)], preflop)).toBe(true);
		expect(facingShortAllIn([deal(), shove(60)], preflop)).toBe(false);
	});

	// Postflop an opening shove has no previous level to double, so the big blind is
	// the bar — anything smaller is a short all-in.
	it('measures an opening postflop shove against the big blind', () => {
		expect(facingShortAllIn([deal(), bet(5, true)], session)).toBe(true);
		expect(facingShortAllIn([deal(), bet(80, true)], session)).toBe(false);
	});

	it('ignores the previous street', () => {
		const events = [deal(), event({ type: 'bet', amount: 30, all_in: true, street: 'preflop' })];
		expect(facingShortAllIn(events, session)).toBe(false);
	});

	// Only the hand being played now counts; the shove that ended the last one is over.
	it('ignores earlier hands', () => {
		const events = [deal(), bet(100), raise(130, true), deal(), bet(100)];
		expect(facingShortAllIn(events, session)).toBe(false);
	});
});
