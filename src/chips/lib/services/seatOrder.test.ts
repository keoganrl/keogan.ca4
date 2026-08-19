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
	leaveTable,
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
		game_mode: 'cash',
		host_player_id: null,
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
		last_active_at: null,
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
