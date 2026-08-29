import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Player, Session } from '../types';

// Rows the mocked client hands back for `select('*')`. Writes are recorded so the tests
// can assert on what actually hit the database (the button move is a `sessions` update).
const rows: { players: Player[] } = { players: [] };
const writes: { table: string; values: Record<string, unknown> }[] = [];

vi.mock('../supabase', () => {
	const from = (table: string) => {
		const b: Record<string, unknown> & {
			_update?: Record<string, unknown>;
			_insert?: boolean;
		} = {};
		b.select = () => b;
		b.single = () => b;
		b.eq = () => b;
		b.neq = () => b;
		b.gt = () => b;
		b.is = () => b;
		b.or = () => b;
		b.in = () => b;
		b.order = () => b;
		b.limit = () => b;
		b.insert = (values: Record<string, unknown>) => {
			writes.push({ table, values });
			b._insert = true;
			return b;
		};
		b.update = (values: Record<string, unknown>) => {
			b._update = values;
			return b;
		};
		b.then = (resolve: (v: unknown) => unknown) => {
			if (b._update) {
				writes.push({ table, values: b._update });
				return Promise.resolve({ data: [{ id: 'x' }], error: null }).then(resolve);
			}
			if (b._insert) return Promise.resolve({ data: null, error: null }).then(resolve);
			return Promise.resolve({
				data: table === 'players' ? rows.players : null,
				error: null
			}).then(resolve);
		};
		return b;
	};
	return { supabase: { from } };
});

const {
	buttonIndexIn,
	getActionOrder,
	firstPostflopActor,
	nextButtonPlayerId,
	advanceTurn,
	leaveTable,
	kickPlayer,
	blindSeats,
	postBlinds,
	endHand
} = await import('./table');

function player(id: string, seat: number, over: Partial<Player> = {}): Player {
	return {
		id,
		session_id: 'sess',
		identity_id: id,
		display_name: id,
		stack: 100,
		total_buyin: 100,
		is_host: false,
		is_active: true,
		folded: false,
		current_round_bet: 0,
		acted_on_street: null,
		hand_total_bet: 0,
		last_heartbeat_at: '',
		seat_order: seat,
		...over
	};
}

function session(over: Partial<Session> = {}): Session {
	return {
		id: 'sess',
		join_code: 'WOLF',
		status: 'active',
		series_id: 'series-1',
		game_mode: 'cash',
		small_blind: 1,
		big_blind: 2,
		starting_stack: 100,
		blind_level: 0,
		blind_level_started_at: null,
		blind_schedule: [],
		auto_escalate: false,
		button_player_id: null,
		current_actor_id: 'a',
		current_bet: 0,
		pot: 0,
		street: 'preflop',
		created_at: '',
		...over
	};
}

// A four-handed table: seats 0..3.
const a = player('a', 0);
const b = player('b', 1);
const c = player('c', 2);
const d = player('d', 3);

beforeEach(() => {
	rows.players = [];
	writes.length = 0;
});

describe('buttonIndexIn', () => {
	it('returns the seated button’s own index', () => {
		expect(buttonIndexIn([a, b, c, d], session({ button_player_id: 'c' }))).toBe(2);
	});

	it('keeps a dead button on its seat, so the next seat is still the small blind', () => {
		// c left; the button stays on seat 2 and d (seat 3) is still the small blind.
		const s = session({ button_player_id: 'c' });
		const idx = buttonIndexIn([a, b, d], s, [a, b, c, d]);
		expect(idx).toBe(1);
		expect([a, b, d][(idx! + 1) % 3].id).toBe('d');
	});

	it('wraps when the dead button sits past the last remaining seat', () => {
		const s = session({ button_player_id: 'd' });
		const idx = buttonIndexIn([a, b, c], s, [a, b, c, d]);
		expect(idx).toBe(-1);
		expect([a, b, c][(idx! + 1) % 3].id).toBe('a');
	});

	it('returns null when the button cannot be placed at all', () => {
		expect(buttonIndexIn([a, b, c], session({ button_player_id: null }))).toBeNull();
		expect(buttonIndexIn([a, b, c], session({ button_player_id: 'ghost' }), [a, b, c])).toBeNull();
	});
});

describe('getActionOrder with a dead button', () => {
	const s = session({ button_player_id: 'c' });

	it('starts postflop action at the seat left of the empty button seat', () => {
		expect(getActionOrder(s, [a, b, d], false, [a, b, c, d]).map((p) => p.id)).toEqual([
			'd',
			'a',
			'b'
		]);
	});

	it('starts preflop action three seats off the empty button seat', () => {
		// SB d, BB a, so the first to act is b.
		expect(getActionOrder(s, [a, b, d], true, [a, b, c, d]).map((p) => p.id)).toEqual([
			'b',
			'd',
			'a'
		]);
	});

	it('without the full roster it falls back to seat 0 as the button', () => {
		// The old behaviour, still what happens when the caller has no way to place the
		// button — documents the fallback rather than endorsing it.
		expect(getActionOrder(s, [a, b, d], false).map((p) => p.id)).toEqual(['b', 'd', 'a']);
	});

	it('is unchanged when the button is still seated', () => {
		expect(
			getActionOrder(session({ button_player_id: 'b' }), [a, b, c, d], false, [
				a,
				b,
				c,
				d
			]).map((p) => p.id)
		).toEqual(['c', 'd', 'a', 'b']);
	});
});

describe('firstPostflopActor with a dead button', () => {
	it('skips folded and all-in players from the dead button’s seat', () => {
		const s = session({ button_player_id: 'c' });
		const dFolded = player('d', 3, { folded: true });
		const actor = firstPostflopActor(s, [a, b, dFolded], [a, b, c, dFolded]);
		expect(actor?.id).toBe('a');
	});
});

describe('nextButtonPlayerId with a dead button', () => {
	it('advances one seat off the empty button seat', () => {
		const s = session({ button_player_id: 'c' });
		expect(nextButtonPlayerId(s, [a, b, d], [a, b, c, d])).toBe('d');
	});

	it('wraps to the first seat when the dead button sits last', () => {
		const s = session({ button_player_id: 'd' });
		expect(nextButtonPlayerId(s, [a, b, c], [a, b, c, d])).toBe('a');
	});
});

describe('leaveTable', () => {
	it('leaves the button where it is when a hand is in play', async () => {
		const s = session({ button_player_id: 'c', current_actor_id: 'a' });
		await leaveTable(c, s, [a, b, c, d]);
		expect(writes.filter((w) => w.table === 'sessions')).toEqual([]);
	});

	it('rotates the button when no hand is in play', async () => {
		const s = session({ button_player_id: 'c', current_actor_id: null });
		await leaveTable(c, s, [a, b, c, d]);
		expect(writes.filter((w) => w.table === 'sessions')).toEqual([
			{ table: 'sessions', values: { button_player_id: 'd' } }
		]);
	});

	it('does nothing to the button when a non-button player leaves', async () => {
		const s = session({ button_player_id: 'c', current_actor_id: null });
		await leaveTable(a, s, [a, b, c, d]);
		expect(writes.filter((w) => w.table === 'sessions')).toEqual([]);
	});

	// Standing up mid-hand has to be written as a fold. Without it the ledger has no
	// fold for them, so player_stats scores a hand they walked out on as a hand they
	// took to showdown — and if the turn was theirs, current_actor_id goes on pointing
	// at a phone that has left the page.
	it('folds a player who leaves mid-hand', async () => {
		const s = session({ button_player_id: 'a', current_actor_id: 'b', street: 'flop' });
		await leaveTable(c, s, [a, b, c, d]);

		expect(writes).toContainEqual({
			table: 'players',
			values: { folded: true, acted_on_street: 'flop' }
		});
		expect(
			writes.filter((w) => w.table === 'events').map((w) => w.values.type)
		).toEqual(['fold', 'leave']);
	});

	it('passes the action on when the player leaving was holding it', async () => {
		const s = session({ button_player_id: 'a', current_actor_id: 'b', street: 'flop' });
		await leaveTable(b, s, [a, b, c, d]);

		// c is the next seat along, and the turn must not stay on b.
		expect(writes).toContainEqual({
			table: 'sessions',
			values: { current_actor_id: 'c' }
		});
	});

	it('does not touch the turn when the player leaving was not holding it', async () => {
		const s = session({ button_player_id: 'a', current_actor_id: 'b', street: 'flop' });
		await leaveTable(d, s, [a, b, c, d]);

		expect(writes.filter((w) => w.table === 'sessions')).toEqual([]);
	});

	it('writes no fold when there is no hand in play', async () => {
		const s = session({ button_player_id: 'a', current_actor_id: null });
		await leaveTable(c, s, [a, b, c, d]);

		expect(
			writes.filter((w) => w.table === 'events').map((w) => w.values.type)
		).toEqual(['leave']);
	});
});

// Nothing in the database forbids two rows sharing a seat number, and a join race is
// how it happens. Every ordering therefore breaks the tie by id, and the turn has to
// advance by that same comparator.
describe('advanceTurn with duplicate seat numbers', () => {
	it('reaches the second player on a shared seat instead of stepping over them', async () => {
		// Two players both landed on seat 1. Sorted by (seat, id) that is x then y.
		const x = player('x', 1);
		const y = player('y', 1);
		const s = session({ current_actor_id: 'x' });

		await advanceTurn(s, [a, x, y, d]);

		// A raw `seat_order > 1` test skips y entirely and jumps to d, and since the same
		// thing happens on every lap y never acts and the street can never end.
		expect(writes).toContainEqual({
			table: 'sessions',
			values: { current_actor_id: 'y' }
		});
	});

	it('still wraps to the front from the last seat', async () => {
		const s = session({ current_actor_id: 'd' });

		await advanceTurn(s, [a, b, c, d]);

		expect(writes).toContainEqual({
			table: 'sessions',
			values: { current_actor_id: 'a' }
		});
	});
});

describe('kickPlayer', () => {
	// foldHand advances the turn from current_actor_id whoever it is handed, so kicking
	// a player who was sitting quietly used to skip the turn of whoever was thinking.
	it('folds a kicked non-actor without moving the turn', async () => {
		const s = session({ button_player_id: 'a', current_actor_id: 'b', street: 'flop' });
		await kickPlayer(d, s, [a, b, c, d]);

		expect(writes).toContainEqual({
			table: 'players',
			values: { folded: true, acted_on_street: 'flop' }
		});
		expect(writes.filter((w) => w.table === 'sessions')).toEqual([]);
	});

	it('moves the turn on when the kicked player was the actor', async () => {
		const s = session({ button_player_id: 'a', current_actor_id: 'd', street: 'flop' });
		await kickPlayer(d, s, [a, b, c, d]);

		// Wraps past the end of the seat list back to a.
		expect(writes).toContainEqual({
			table: 'sessions',
			values: { current_actor_id: 'a' }
		});
	});
});

// Heads-up the button posts the small blind and speaks first before the flop, then
// last on every street after it. The app had the opposite arrangement (dealer on the
// big blind) until 2026-08.
describe('heads-up', () => {
	const hu = [player('btn', 0), player('other', 1)];

	it('puts the small blind on the button', () => {
		const s = session({ button_player_id: 'btn' });
		const { sb, bb } = blindSeats(hu, s);
		expect([sb?.id, bb?.id]).toEqual(['btn', 'other']);
	});

	it('has the button act first preflop', () => {
		const s = session({ button_player_id: 'btn' });
		expect(getActionOrder(s, hu, true).map((p) => p.id)).toEqual(['btn', 'other']);
	});

	it('has the big blind act first after the flop', () => {
		const s = session({ button_player_id: 'btn' });
		expect(getActionOrder(s, hu, false).map((p) => p.id)).toEqual(['other', 'btn']);
	});

	it('posts the blinds on the seats blindSeats names', async () => {
		const s = session({ button_player_id: 'btn', small_blind: 1, big_blind: 2 });
		await postBlinds(s, hu);

		const posted = writes
			.filter((w) => w.table === 'events' && String(w.values.type).startsWith('post_'))
			.map((w) => [w.values.type, w.values.player_id]);
		expect(posted).toEqual([
			['post_sb', 'btn'],
			['post_bb', 'other']
		]);
	});

	// Three-handed and up is unchanged: the button is neither blind.
	it('leaves three-handed blinds alone', () => {
		const s = session({ button_player_id: 'a' });
		const { sb, bb } = blindSeats([a, b, c], s);
		expect([sb?.id, bb?.id]).toEqual(['b', 'c']);
	});
});

describe('endHand after somebody leaves mid-hand', () => {
	it('moves the button exactly one seat past the seat that left', async () => {
		// c held the button and walked away mid-hand; their row survives, inactive.
		const gone = player('c', 2, { is_active: false });
		rows.players = [a, b, gone, d];
		const s = session({ button_player_id: 'c' });

		await endHand(s, [a, b, gone, d], null, 0);

		const buttonWrite = writes.find(
			(w) => w.table === 'sessions' && 'button_player_id' in w.values
		);
		// Not 'a' — that is the seat-0 fallback the old code fell into once the leaver's
		// row was filtered out, which skipped d's turn on the button entirely.
		expect(buttonWrite?.values.button_player_id).toBe('d');
	});

	it('blinds follow the new button, so nobody posts twice in a row', async () => {
		const gone = player('c', 2, { is_active: false });
		rows.players = [a, b, gone, d];
		const s = session({ button_player_id: 'c' });

		await endHand(s, [a, b, gone, d], null, 0);

		// Button d (seat 3) ⇒ SB a (seat 0), BB b (seat 1).
		const blinds = writes.filter(
			(w) => w.table === 'events' && String(w.values.type).startsWith('post_')
		);
		expect(blinds.map((w) => [w.values.type, w.values.player_id])).toEqual([
			['post_sb', 'a'],
			['post_bb', 'b']
		]);
	});
});
