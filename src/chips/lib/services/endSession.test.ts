import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Player } from '../types';

// Minimal stand-in for the supabase client: enough of the query builder for
// endSession (select/update, eq, single) with the builder itself thenable, so
// `await` and Promise.all resolve it the way the real one does. Reads come from
// `state`; writes are recorded for assertions.
const state: { players: Player[]; pot: number } = { players: [], pot: 0 };
const writes: { table: string; id: string; values: Record<string, unknown> }[] = [];

vi.mock('../supabase', () => {
	const from = (table: string) => {
		const b: Record<string, unknown> & { _update?: Record<string, unknown>; _id?: string } = {};
		const chain = <T>(fn: () => T) => fn();
		b.select = () => b;
		b.single = () => b;
		b.update = (values: Record<string, unknown>) => {
			b._update = values;
			return b;
		};
		b.eq = (col: string, val: string) => {
			if (col === 'id') b._id = val;
			return b;
		};
		b.then = (resolve: (v: unknown) => unknown) =>
			Promise.resolve(
				chain(() => {
					if (b._update) {
						writes.push({ table, id: b._id ?? '', values: b._update });
						return { data: null, error: null };
					}
					return table === 'players'
						? { data: state.players, error: null }
						: { data: { pot: state.pot }, error: null };
				})
			).then(resolve);
		return b;
	};
	return { supabase: { from } };
});

const { endSession } = await import('./table');

function player(id: string, over: Partial<Player> = {}): Player {
	return {
		id,
		session_id: 'S',
		identity_id: `i-${id}`,
		display_name: id,
		stack: 0,
		total_buyin: 1000,
		is_host: false,
		is_active: true,
		folded: false,
		current_round_bet: 0,
		acted_on_street: null,
		hand_total_bet: 0,
		last_heartbeat_at: '',
		seat_order: 0,
		...over
	};
}

const stackWrites = () =>
	Object.fromEntries(
		writes
			.filter((w) => w.table === 'players' && 'stack' in w.values)
			.map((w) => [w.id, w.values.stack as number])
	);

beforeEach(() => {
	writes.length = 0;
	state.players = [];
	state.pot = 0;
});

describe('endSession', () => {
	// The 2026-08-14 bug: hand_total_bet is only cleared by the next deal, so ending
	// the session right after the last showdown found everyone's final-hand commitment
	// still sitting there and handed it back — on top of the pot the winners had
	// already been awarded. A 9000-chip session cashed out at 12290.
	it('refunds nothing when the last hand was already awarded', async () => {
		state.pot = 0;
		state.players = [
			player('winner', { stack: 3290, hand_total_bet: 2590 }),
			player('loser', { stack: 0, hand_total_bet: 460 }),
			player('other', { stack: 0, hand_total_bet: 240 })
		];

		await endSession('S');

		expect(stackWrites()).toEqual({ winner: 3290, loser: 0, other: 0 });
	});

	it('clears the stale hand columns even when nothing is refunded', async () => {
		state.pot = 0;
		state.players = [player('a', { stack: 500, hand_total_bet: 300, current_round_bet: 100 })];

		await endSession('S');

		const w = writes.find((x) => x.table === 'players');
		expect(w?.values).toMatchObject({ hand_total_bet: 0, current_round_bet: 0 });
	});

	it('hands back the felt when the session ends mid-hand', async () => {
		state.pot = 130;
		state.players = [
			player('sb', { stack: 900, hand_total_bet: 10 }),
			player('bb', { stack: 800, hand_total_bet: 20 }),
			player('bettor', { stack: 700, hand_total_bet: 100 })
		];

		await endSession('S');

		expect(stackWrites()).toEqual({ sb: 910, bb: 820, bettor: 800 });
	});

	// A showdown awarded round by round can be ended between rounds: the pot holds
	// only what is left to pay. Refunds are capped at it, so the books still balance.
	it('never hands back more than the pot still holds', async () => {
		state.pot = 300;
		state.players = [
			player('big', { stack: 0, hand_total_bet: 500 }),
			player('small', { stack: 0, hand_total_bet: 200 })
		];

		await endSession('S');

		const paid = Object.values(stackWrites()).reduce((a, b) => a + b, 0);
		expect(paid).toBe(300);
	});

	it('closes the books', async () => {
		state.players = [player('a')];

		await endSession('S');

		expect(writes.find((w) => w.table === 'sessions')?.values).toMatchObject({
			status: 'ended',
			pot: 0
		});
	});
});
