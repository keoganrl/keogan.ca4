import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  selectForAutoEnd,
  planRefunds,
  cutoffFrom,
  IDLE_HOURS,
  MAX_PER_RUN,
  OPEN_STATUSES,
} from './_autoEnd.js';

const CUTOFF = new Date('2026-09-02T00:00:00Z');
const stale = (id, status = 'active') => ({
  id,
  status,
  lastActivity: '2026-09-01T00:00:00Z',
});

describe('cutoffFrom', () => {
  it('is IDLE_HOURS in the past', () => {
    const now = Date.parse('2026-09-02T18:00:00Z');
    expect(cutoffFrom(now).toISOString()).toBe('2026-09-02T00:00:00.000Z');
    expect(IDLE_HOURS).toBe(18);
  });
});

describe('selectForAutoEnd', () => {
  it('returns the ids of sessions quiet since before the cutoff', () => {
    expect(selectForAutoEnd([stale('a'), stale('b')], CUTOFF)).toEqual({
      ok: true,
      ids: ['a', 'b'],
    });
  });

  it('closes nothing when there is nothing open', () => {
    expect(selectForAutoEnd([], CUTOFF)).toEqual({ ok: true, ids: [] });
  });

  it('treats a paused session as open too', () => {
    expect(OPEN_STATUSES).toContain('paused');
    expect(selectForAutoEnd([stale('a', 'paused')], CUTOFF).ok).toBe(true);
  });

  // The status filter travels as a query string; a dropped parameter widens the
  // result to every session in the table rather than erroring.
  it('refuses when an already-ended session comes back', () => {
    const r = selectForAutoEnd([stale('a'), stale('b', 'ended')], CUTOFF);
    expect(r.ok).toBe(false);
    expect(r.offending).toEqual(['b']);
  });

  it('refuses when a waiting session comes back', () => {
    // A waiting session was never started, so there is no "end session" to skip and
    // no players to settle. Closing one would put an empty row on the leaderboard.
    expect(selectForAutoEnd([stale('a', 'waiting')], CUTOFF).ok).toBe(false);
  });

  it('refuses a session that has been active more recently than the cutoff', () => {
    const r = selectForAutoEnd(
      [stale('a'), { id: 'b', status: 'active', lastActivity: '2026-09-02T06:00:00Z' }],
      CUTOFF
    );
    expect(r.ok).toBe(false);
    expect(r.offending).toEqual(['b']);
  });

  // Exactly at the cutoff is not past it — ending a boundary session is the kind of
  // off-by-one that shows up as somebody's game closing while they are looking at it.
  it('refuses a session whose last activity is exactly the cutoff', () => {
    const r = selectForAutoEnd(
      [{ id: 'a', status: 'active', lastActivity: CUTOFF.toISOString() }],
      CUTOFF
    );
    expect(r.ok).toBe(false);
  });

  it('refuses an unparseable or missing timestamp', () => {
    expect(selectForAutoEnd([{ id: 'a', status: 'active', lastActivity: 'nope' }], CUTOFF).ok).toBe(
      false
    );
    expect(selectForAutoEnd([{ id: 'a', status: 'active' }], CUTOFF).ok).toBe(false);
  });

  it('refuses a row with no id, which cannot be closed by id', () => {
    expect(selectForAutoEnd([{ status: 'active', lastActivity: '2026-09-01T00:00:00Z' }], CUTOFF).ok).toBe(
      false
    );
  });

  it('refuses more than MAX_PER_RUN candidates', () => {
    const many = Array.from({ length: MAX_PER_RUN + 1 }, (_, i) => stale(`s${i}`));
    const r = selectForAutoEnd(many, CUTOFF);
    expect(r.ok).toBe(false);
    expect(r.count).toBe(MAX_PER_RUN + 1);
  });

  it('allows exactly MAX_PER_RUN', () => {
    const many = Array.from({ length: MAX_PER_RUN }, (_, i) => stale(`s${i}`));
    expect(selectForAutoEnd(many, CUTOFF).ok).toBe(true);
  });

  // A future cutoff would sweep up games being played right now.
  it('refuses a cutoff in the future', () => {
    const r = selectForAutoEnd([stale('a')], new Date(Date.now() + 60_000));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/future/);
  });

  it('refuses a cutoff that is not a date, and a candidate list that is not a list', () => {
    expect(selectForAutoEnd([stale('a')], 'yesterday').ok).toBe(false);
    expect(selectForAutoEnd([stale('a')], new Date('nonsense')).ok).toBe(false);
    expect(selectForAutoEnd(null, CUTOFF).ok).toBe(false);
  });
});

describe('planRefunds', () => {
  const p = (id, over = {}) => ({
    id,
    stack: 0,
    hand_total_bet: 0,
    current_round_bet: 0,
    ...over,
  });

  it('hands back nothing when the pot is empty', () => {
    // pot === 0 means the hand was awarded and the winners already hold those chips.
    // Refunding hand_total_bet here is exactly the 2026-08-14 double-pay bug.
    const players = [p('a', { stack: 500, hand_total_bet: 300 })];
    expect(planRefunds(players, 0)).toEqual([{ id: 'a', refund: 0, stack: 500 }]);
  });

  it('hands the felt back when a hand was abandoned mid-way', () => {
    const players = [
      p('a', { stack: 700, hand_total_bet: 300 }),
      p('b', { stack: 800, hand_total_bet: 200 }),
    ];
    expect(planRefunds(players, 500)).toEqual([
      { id: 'a', refund: 300, stack: 1000 },
      { id: 'b', refund: 200, stack: 1000 },
    ]);
  });

  it('never hands back more than the pot, largest contributor first', () => {
    // A partially awarded showdown: the pot no longer covers everyone's commitment.
    const players = [
      p('small', { stack: 100, hand_total_bet: 100 }),
      p('big', { stack: 100, hand_total_bet: 400 }),
    ];
    const out = planRefunds(players, 300);
    expect(out).toEqual([
      { id: 'big', refund: 300, stack: 400 },
      { id: 'small', refund: 0, stack: 100 },
    ]);
    expect(out.reduce((n, r) => n + r.refund, 0)).toBe(300);
  });

  it('conserves chips: the total handed back is exactly the pot', () => {
    for (const pot of [0, 1, 50, 500, 5000]) {
      const players = [
        p('a', { stack: 10, hand_total_bet: 120 }),
        p('b', { stack: 20, hand_total_bet: 300 }),
        p('c', { stack: 30, hand_total_bet: 80 }),
      ];
      const committed = 500;
      const handedBack = planRefunds(players, pot).reduce((n, r) => n + r.refund, 0);
      expect(handedBack).toBe(Math.min(pot, committed));
    }
  });

  it('includes a player who left mid-hand, so their net comes out right', () => {
    const players = [p('gone', { stack: 0, hand_total_bet: 250, is_active: false })];
    expect(planRefunds(players, 250)).toEqual([{ id: 'gone', refund: 250, stack: 250 }]);
  });

  it('clears a stray current_round_bet even with nothing to refund', () => {
    // The write happens for the bet columns' sake; the refund is zero.
    const players = [p('a', { stack: 400, hand_total_bet: 0, current_round_bet: 25 })];
    expect(planRefunds(players, 0)).toEqual([{ id: 'a', refund: 0, stack: 400 }]);
  });

  it('leaves settled players alone entirely', () => {
    expect(planRefunds([p('a', { stack: 900 })], 0)).toEqual([]);
  });

  it('tolerates a missing pot and an empty table', () => {
    expect(planRefunds([p('a', { stack: 5, hand_total_bet: 5 })], undefined)).toEqual([
      { id: 'a', refund: 0, stack: 5 },
    ]);
    expect(planRefunds([], 100)).toEqual([]);
    expect(planRefunds(undefined, 100)).toEqual([]);
  });
});

// ---------------------------------------------------------------- the endpoint

const calls = [];
const state = { pingOk: true, open: [], lastEvent: {}, players: {}, pot: {}, casWins: true };

global.fetch = vi.fn(async (url, init = {}) => {
  const path = String(url).split('/rest/v1/')[1];
  calls.push({ path, method: init.method ?? 'GET', body: init.body });
  const ok = (data) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
    json: async () => data,
  });
  if (path.startsWith('guestbook_entries')) {
    return state.pingOk ? ok([]) : { ok: false, status: 503, text: async () => 'paused' };
  }
  // jsonAll pages until it gets an empty response, so anything it calls has to
  // honour limit/offset — a mock that ignores them loops until the runaway guard.
  const page = (rows) => {
    const offset = Number(path.match(/[?&]offset=(\d+)/)?.[1] ?? 0);
    const limit = Number(path.match(/[?&]limit=(\d+)/)?.[1] ?? rows.length);
    return ok(rows.slice(offset, offset + limit));
  };
  if (path.startsWith('sessions?select=id,join_code,status,created_at')) return page(state.open);
  if (path.startsWith('events?select=created_at')) {
    const id = path.match(/session_id=eq\.([^&]+)/)[1];
    return ok(state.lastEvent[id] ? [{ created_at: state.lastEvent[id] }] : []);
  }
  if (path.startsWith('players?select=')) {
    const id = path.match(/session_id=eq\.([^&]+)/)[1];
    return page(state.players[id] ?? []);
  }
  if (path.startsWith('sessions?select=pot')) {
    const id = path.match(/id=eq\.([^&]+)/)[1];
    return ok([{ pot: state.pot[id] ?? 0 }]);
  }
  if (path.includes('status=neq.ended') && init.method === 'PATCH') {
    const id = path.match(/id=eq\.([^&]+)/)[1];
    return ok(state.casWins ? [{ id }] : []);
  }
  if (path.startsWith('players?id=eq.') && init.method === 'PATCH') return ok(null);
  if (path.startsWith('rpc/refresh_player_stats')) return ok(null);
  if (path.startsWith('sessions?select=id,created_at,series_id')) return ok([]);
  return { ok: false, status: 404, text: async () => `unknown: ${path}` };
});

const { default: handler } = await import('./keep-alive.js');

function res() {
  const r = { code: 200, body: null };
  r.status = (c) => ((r.code = c), r);
  r.json = (b) => ((r.body = b), r);
  return r;
}
const req = () => ({ headers: { authorization: 'Bearer secret' } });
const hoursAgo = (n) => new Date(Date.now() - n * 3600_000).toISOString();

beforeEach(() => {
  process.env.CRON_SECRET = 'secret';
  process.env.PUBLIC_SUPABASE_URL = 'https://db.test';
  process.env.PUBLIC_SUPABASE_ANON_KEY = 'anon';
  delete process.env.PURGE_ENABLED;
  calls.length = 0;
  state.pingOk = true;
  state.open = [];
  state.lastEvent = {};
  state.players = {};
  state.pot = {};
  state.casWins = true;
});

const patched = (frag) =>
  calls.filter((c) => c.method === 'PATCH' && c.path.includes(frag));

describe('auto-end in the cron', () => {
  it('closes a session whose last event is older than 18 hours', async () => {
    state.open = [{ id: 'a', join_code: 'WOLF', status: 'active', created_at: hoursAgo(40) }];
    state.lastEvent = { a: hoursAgo(30) };
    const r = res();
    await handler(req(), r);
    expect(r.body.autoEnd).toMatchObject({ ok: true, ended: 1, ids: ['a'] });
    expect(patched('status=neq.ended')).toHaveLength(1);
  });

  it('leaves a session alone that had an event within the window', async () => {
    state.open = [{ id: 'a', join_code: 'WOLF', status: 'active', created_at: hoursAgo(40) }];
    state.lastEvent = { a: hoursAgo(2) };
    const r = res();
    await handler(req(), r);
    expect(r.body.autoEnd).toMatchObject({ ended: 0 });
    expect(patched('status=neq.ended')).toHaveLength(0);
  });

  // A session started but never dealt has no events at all.
  it('falls back to created_at when no hand was ever dealt', async () => {
    state.open = [{ id: 'a', join_code: 'WOLF', status: 'active', created_at: hoursAgo(40) }];
    const r = res();
    await handler(req(), r);
    expect(r.body.autoEnd).toMatchObject({ ended: 1, ids: ['a'] });
  });

  it('hands the felt back before closing the books', async () => {
    state.open = [{ id: 'a', join_code: 'WOLF', status: 'active', created_at: hoursAgo(40) }];
    state.lastEvent = { a: hoursAgo(30) };
    state.pot = { a: 500 };
    state.players = {
      a: [
        { id: 'p1', stack: 700, hand_total_bet: 300, current_round_bet: 0 },
        { id: 'p2', stack: 800, hand_total_bet: 200, current_round_bet: 0 },
      ],
    };
    await handler(req(), res());
    const refunds = patched('players?id=eq.').map((c) => JSON.parse(c.body).stack);
    expect(refunds).toEqual([1000, 1000]);
  });

  // The host tapping "End session" as the cron fires must not pay the felt twice.
  it('writes no refunds when it loses the compare-and-swap', async () => {
    state.casWins = false;
    state.open = [{ id: 'a', join_code: 'WOLF', status: 'active', created_at: hoursAgo(40) }];
    state.pot = { a: 500 };
    state.players = { a: [{ id: 'p1', stack: 700, hand_total_bet: 300, current_round_bet: 0 }] };
    const r = res();
    await handler(req(), r);
    expect(patched('players?id=eq.')).toHaveLength(0);
    expect(r.body.autoEnd.ended).toBe(0);
  });

  it('refreshes player_stats only when something actually closed', async () => {
    await handler(req(), res());
    expect(calls.filter((c) => c.path.startsWith('rpc/refresh_player_stats'))).toHaveLength(0);

    calls.length = 0;
    state.open = [{ id: 'a', join_code: 'WOLF', status: 'active', created_at: hoursAgo(40) }];
    await handler(req(), res());
    expect(calls.filter((c) => c.path.startsWith('rpc/refresh_player_stats'))).toHaveLength(1);
  });

  // The ping is the load-bearing half; the two sweeps must not be able to sink it.
  it('still reports the ping ok when auto-end refuses', async () => {
    state.open = [{ id: 'a', join_code: 'WOLF', status: 'ended', created_at: hoursAgo(40) }];
    state.lastEvent = { a: hoursAgo(30) };
    const r = res();
    await handler(req(), r);
    expect(r.code).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.autoEnd.ok).toBe(false);
    expect(patched('status=neq.ended')).toHaveLength(0);
  });

  it('does nothing at all when the ping fails', async () => {
    state.pingOk = false;
    state.open = [{ id: 'a', join_code: 'WOLF', status: 'active', created_at: hoursAgo(40) }];
    const r = res();
    await handler(req(), r);
    expect(r.code).toBe(500);
    expect(patched('status=neq.ended')).toHaveLength(0);
  });
});
