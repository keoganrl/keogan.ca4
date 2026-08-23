import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Player } from '../types';

// Every function here writes stacks as ABSOLUTE values, which is the class of write
// that has minted and vanished chips in this app before. So the mock deliberately
// disagrees with the caller: `db` holds what the database really has, the Player
// objects the tests pass in hold what a lagging realtime cache would have shown. A
// function that reads fresh writes the db value; one that trusts its argument writes
// the stale one, and the difference is what these tests assert.
const db: Record<string, { stack: number; total_buyin: number }> = {};
const writes: { table: string; id: string; values: Record<string, unknown> }[] = [];

vi.mock('../supabase', () => {
	const from = (table: string) => {
		const b: Record<string, unknown> & {
			_update?: Record<string, unknown>;
			_insert?: boolean;
			_ids?: string[];
		} = {};
		b.select = () => b;
		b.single = () => b;
		b.eq = (col: string, val: string) => {
			if (col === 'id') b._ids = [val];
			return b;
		};
		b.in = (_col: string, vals: string[]) => {
			b._ids = vals;
			return b;
		};
		b.insert = () => {
			b._insert = true;
			return b;
		};
		b.update = (values: Record<string, unknown>) => {
			b._update = values;
			return b;
		};
		b.then = (resolve: (v: unknown) => unknown) => {
			if (b._update) {
				writes.push({ table, id: b._ids?.[0] ?? '', values: b._update });
				return Promise.resolve({ data: null, error: null }).then(resolve);
			}
			if (b._insert) return Promise.resolve({ data: null, error: null }).then(resolve);
			const rows = (b._ids ?? []).map((id) => ({ id, ...db[id] }));
			// .single() collapses to one row; the mock cannot tell, so hand back both
			// shapes and let the caller pick the one it destructures.
			return Promise.resolve({
				data: rows.length === 1 ? { ...rows[0] } : rows,
				error: null
			}).then(resolve);
		};
		return b;
	};
	return { supabase: { from } };
});

const { giveChips, doRebuy } = await import('./table');

function player(id: string, stack: number, over: Partial<Player> = {}): Player {
	return {
		id,
		session_id: 'S',
		identity_id: `i-${id}`,
		display_name: id,
		stack,
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

const stackWrite = (id: string) =>
	writes.filter((w) => w.id === id && 'stack' in w.values).at(-1)?.values.stack;

beforeEach(() => {
	writes.length = 0;
	for (const k of Object.keys(db)) delete db[k];
});

describe('giveChips', () => {
	it('moves the chips across', async () => {
		db.giver = { stack: 500, total_buyin: 1000 };
		db.taker = { stack: 200, total_buyin: 1000 };

		await giveChips(player('giver', 500), player('taker', 200), 100);

		expect(stackWrite('giver')).toBe(400);
		expect(stackWrite('taker')).toBe(300);
	});

	// The recipient just won a pot and this client has not seen the echo yet. Crediting
	// from the cached 200 would write 300 and wipe the 600 they were awarded.
	it('credits the recipient from their real stack, not the cached one', async () => {
		db.giver = { stack: 500, total_buyin: 1000 };
		db.taker = { stack: 800, total_buyin: 1000 };

		await giveChips(player('giver', 500), player('taker', 200), 100);

		expect(stackWrite('taker')).toBe(900);
	});

	// The mirror case: the cache still shows chips this player has already bet.
	it('refuses a gift the giver can no longer afford', async () => {
		db.giver = { stack: 20, total_buyin: 1000 };
		db.taker = { stack: 200, total_buyin: 1000 };

		await giveChips(player('giver', 500), player('taker', 200), 100);

		expect(writes).toEqual([]);
	});

	it('refuses nonsense amounts and self-gifts', async () => {
		db.giver = { stack: 500, total_buyin: 1000 };
		db.taker = { stack: 200, total_buyin: 1000 };
		const giver = player('giver', 500);

		await giveChips(giver, player('taker', 200), 0);
		await giveChips(giver, player('taker', 200), -50);
		await giveChips(giver, player('taker', 200), 10.5);
		await giveChips(giver, giver, 50);
		await giveChips(giver, player('taker', 200, { is_active: false }), 50);

		expect(writes).toEqual([]);
	});
});

describe('doRebuy', () => {
	it('tops the stack up and records the buy-in', async () => {
		db.busted = { stack: 0, total_buyin: 1000 };

		await doRebuy(player('busted', 0), 1000);

		expect(writes.at(0)?.values).toMatchObject({ stack: 1000, total_buyin: 2000 });
	});

	// A rebuy is bought at the moment of busting, right behind the award that busted
	// them. Topping up from a cache that predates it re-credits chips already lost.
	it('tops up from the real stack, not the cached one', async () => {
		db.busted = { stack: 0, total_buyin: 1000 };

		await doRebuy(player('busted', 400), 1000);

		expect(writes.at(0)?.values).toMatchObject({ stack: 1000, total_buyin: 2000 });
	});

	it('refuses nonsense amounts', async () => {
		db.busted = { stack: 0, total_buyin: 1000 };

		await doRebuy(player('busted', 0), 0);
		await doRebuy(player('busted', 0), -100);

		expect(writes).toEqual([]);
	});
});
