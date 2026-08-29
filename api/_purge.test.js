import { describe, it, expect, vi, beforeEach } from 'vitest';
import { selectForPurge, cutoffFrom, RETENTION_DAYS, MAX_PER_RUN } from './_purge.js';

const CUTOFF = new Date('2026-08-20T00:00:00Z');
const old = (id) => ({ id, created_at: '2026-08-01T00:00:00Z', series_id: null });

describe('cutoffFrom', () => {
  it('is RETENTION_DAYS in the past', () => {
    const now = Date.parse('2026-08-20T00:00:00Z');
    expect(cutoffFrom(now).toISOString()).toBe('2026-08-15T00:00:00.000Z');
    expect(RETENTION_DAYS).toBe(5);
  });
});

describe('selectForPurge', () => {
  it('returns the ids when every row matches', () => {
    const r = selectForPurge([old('a'), old('b')], CUTOFF);
    expect(r).toEqual({ ok: true, ids: ['a', 'b'] });
  });

  it('issues nothing for an empty candidate set', () => {
    expect(selectForPurge([], CUTOFF)).toEqual({ ok: true, ids: [] });
  });

  // The whole point of the re-check: the filter travels as a query string, and a
  // parameter lost in transit does not error, it just widens the result. A series
  // session coming back here means `series_id=is.null` did not apply.
  it('refuses when a row belongs to a series', () => {
    const r = selectForPurge([old('a'), { ...old('b'), series_id: 'series-1' }], CUTOFF);
    expect(r.ok).toBe(false);
    expect(r.offending).toEqual(['b']);
  });

  it('refuses when a row is newer than the cutoff', () => {
    const r = selectForPurge(
      [old('a'), { id: 'b', created_at: '2026-08-25T00:00:00Z', series_id: null }],
      CUTOFF
    );
    expect(r.ok).toBe(false);
    expect(r.offending).toEqual(['b']);
  });

  // Exactly at the cutoff is not past it. Deleting a boundary row is the kind of
  // off-by-one that only shows up as a missing night.
  it('refuses a row created exactly at the cutoff', () => {
    const r = selectForPurge([{ id: 'a', created_at: CUTOFF.toISOString(), series_id: null }], CUTOFF);
    expect(r.ok).toBe(false);
  });

  it('refuses a row with an unparseable timestamp', () => {
    const r = selectForPurge([{ id: 'a', created_at: 'not a date', series_id: null }], CUTOFF);
    expect(r.ok).toBe(false);
  });

  it('refuses a row with no id, which cannot be deleted by id', () => {
    const r = selectForPurge([{ created_at: '2026-08-01T00:00:00Z', series_id: null }], CUTOFF);
    expect(r.ok).toBe(false);
  });

  // series_id undefined is not series_id null: it means the column was not selected,
  // so nothing here has actually been checked.
  it('refuses when series_id is absent rather than null', () => {
    const r = selectForPurge([{ id: 'a', created_at: '2026-08-01T00:00:00Z' }], CUTOFF);
    expect(r.ok).toBe(false);
  });

  // An unexpectedly large set means the predicate is wrong, not that there was a lot
  // to clean up.
  it('refuses more than MAX_PER_RUN candidates', () => {
    const many = Array.from({ length: MAX_PER_RUN + 1 }, (_, i) => old(`s${i}`));
    const r = selectForPurge(many, CUTOFF);
    expect(r.ok).toBe(false);
    expect(r.count).toBe(MAX_PER_RUN + 1);
  });

  it('allows exactly MAX_PER_RUN', () => {
    const many = Array.from({ length: MAX_PER_RUN }, (_, i) => old(`s${i}`));
    expect(selectForPurge(many, CUTOFF).ok).toBe(true);
  });

  // A future cutoff matches everything, so it is refused before the rows are read.
  it('refuses a cutoff in the future', () => {
    const future = new Date(Date.now() + 60_000);
    const r = selectForPurge([old('a')], future);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/future/);
  });

  it('refuses a cutoff that is not a date', () => {
    expect(selectForPurge([old('a')], 'yesterday').ok).toBe(false);
    expect(selectForPurge([old('a')], new Date('nonsense')).ok).toBe(false);
  });

  it('refuses when the candidate list is not a list', () => {
    expect(selectForPurge(null, CUTOFF).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- the endpoint

const calls = [];
const state = { pingOk: true, rows: [] };

global.fetch = vi.fn(async (url, init = {}) => {
  const path = String(url).split('/rest/v1/')[1];
  calls.push({ path, method: init.method ?? 'GET' });
  const ok = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
  if (path.startsWith('guestbook_entries')) {
    return state.pingOk ? ok([]) : { ok: false, status: 503, text: async () => 'paused' };
  }
  if (path.startsWith('sessions?select')) return ok(state.rows);
  if (path.startsWith('sessions?id=in.')) return ok(null);
  return { ok: false, status: 404, text: async () => 'unknown' };
});

const { default: handler } = await import('./keep-alive.js');

function res() {
  const r = { code: 200, body: null };
  r.status = (c) => ((r.code = c), r);
  r.json = (b) => ((r.body = b), r);
  return r;
}

const req = () => ({ headers: { authorization: 'Bearer secret' } });
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

beforeEach(() => {
  process.env.CRON_SECRET = 'secret';
  process.env.PUBLIC_SUPABASE_URL = 'https://db.test';
  process.env.PUBLIC_SUPABASE_ANON_KEY = 'anon';
  delete process.env.PURGE_ENABLED;
  calls.length = 0;
  state.pingOk = true;
  state.rows = [];
});

const deletes = () => calls.filter((c) => c.method === 'DELETE');

describe('keep-alive', () => {
  it('rejects a request without the cron secret', async () => {
    const r = res();
    await handler({ headers: {} }, r);
    expect(r.code).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('pings before anything else', async () => {
    await handler(req(), res());
    expect(calls[0].path).toMatch(/^guestbook_entries/);
  });

  // The ping is the load-bearing half. If it fails the endpoint fails, and the purge
  // must not have run against a database that could not even be read.
  it('fails and purges nothing when the ping fails', async () => {
    state.pingOk = false;
    state.rows = [{ id: 'a', created_at: daysAgo(30), series_id: null }];
    const r = res();
    await handler(req(), r);
    expect(r.code).toBe(500);
    expect(deletes()).toHaveLength(0);
  });

  it('reports what it would delete without deleting, until PURGE_ENABLED is set', async () => {
    state.rows = [{ id: 'a', created_at: daysAgo(30), series_id: null }];
    const r = res();
    await handler(req(), r);
    expect(r.code).toBe(200);
    expect(r.body.purge).toMatchObject({ ok: true, enabled: false, wouldPurge: 1, ids: ['a'] });
    expect(deletes()).toHaveLength(0);
  });

  it('deletes by explicit id list once enabled, never by filter', async () => {
    process.env.PURGE_ENABLED = '1';
    state.rows = [
      { id: 'a', created_at: daysAgo(30), series_id: null },
      { id: 'b', created_at: daysAgo(9), series_id: null },
    ];
    const r = res();
    await handler(req(), r);
    expect(r.body.purge).toMatchObject({ ok: true, purged: 2 });
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0].path).toBe('sessions?id=in.(a,b)');
    expect(deletes()[0].path).not.toMatch(/series_id/);
  });

  it('issues no delete at all when there is nothing to purge', async () => {
    process.env.PURGE_ENABLED = '1';
    const r = res();
    await handler(req(), r);
    expect(r.body.purge).toMatchObject({ purged: 0 });
    expect(deletes()).toHaveLength(0);
  });

  // A series session in the result set means the filter did not apply. Deleting the
  // rest of that batch would be acting on a list nobody can vouch for.
  it('deletes nothing when a series session appears among the candidates', async () => {
    process.env.PURGE_ENABLED = '1';
    state.rows = [
      { id: 'a', created_at: daysAgo(30), series_id: null },
      { id: 'b', created_at: daysAgo(30), series_id: 'series-1' },
    ];
    const r = res();
    await handler(req(), r);
    expect(r.body.purge.ok).toBe(false);
    expect(deletes()).toHaveLength(0);
  });

  it('still reports the ping as ok when the purge refuses', async () => {
    process.env.PURGE_ENABLED = '1';
    state.rows = [{ id: 'b', created_at: daysAgo(30), series_id: 'series-1' }];
    const r = res();
    await handler(req(), r);
    expect(r.code).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.purge.ok).toBe(false);
  });
});
