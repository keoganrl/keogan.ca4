import { describe, it, expect, vi, beforeEach } from 'vitest';

// The endpoint talks to two services. Both are faked here: Supabase over fetch,
// and the model through the SDK. What is being tested is the decision-making
// between them — when a call is made at all, who gets named, and what is stored.
const calls = { db: [], model: [] };
let modelReply = null;

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    beta = {
      messages: {
        stream: async (args) => {
          calls.model.push(args);
          return { finalMessage: async () => modelReply };
        }
      }
    };
  }
}));

const state = {
  stats: [],
  profiles: [],
  participants: [],
  profilesToday: 0
};

global.fetch = vi.fn(async (url, init = {}) => {
  const path = String(url).split('/rest/v1/')[1];
  calls.db.push({ path, method: init.method ?? 'GET', body: init.body });
  // text(), not json(): the endpoint reads the body as text so it can tolerate the
  // empty one PostgREST returns from a write.
  const ok = (data, headers = {}) => ({
    ok: true,
    status: 200,
    text: async () => (data === null ? '' : JSON.stringify(data)),
    json: async () => data,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null }
  });
  if (path.startsWith('rpc/refresh_player_stats'))
    return { ok: true, status: 204, text: async () => '', headers: { get: () => null } };
  if (path.startsWith('player_stats')) return ok(state.stats);
  if (path.startsWith('player_profiles?select')) return ok(state.profiles);
  if (path.startsWith('player_profiles?generated_at'))
    return ok([], { 'content-range': `0-0/${state.profilesToday}` });
  if (path.startsWith('player_profiles')) return ok(null);
  if (path.startsWith('players?select')) return ok(state.participants);
  return { ok: false, status: 404, text: async () => 'unknown path' };
});

const { default: handler } = await import('./profile.js');

function res() {
  const r = { code: 0, body: null };
  r.status = (c) => ((r.code = c), r);
  r.json = (b) => ((r.body = b), r);
  return r;
}

const stat = (id, name, over = {}) => ({
  identity_id: id,
  display_name: name,
  hands: 150,
  vpip_pct: 45,
  pfr_pct: 20,
  wtsd_pct: 40,
  af: 1.2,
  ...over
});

const ended = (over = {}) => ({
  body: { record: { id: 'S1', status: 'ended' }, old_record: { status: 'active' }, ...over },
  method: 'POST',
  headers: { 'x-webhook-secret': 'shhh' }
});

beforeEach(() => {
  process.env.PROFILE_SECRET = 'shhh';
  process.env.PUBLIC_SUPABASE_URL = 'https://db.test';
  process.env.PUBLIC_SUPABASE_ANON_KEY = 'anon';
  calls.db = [];
  calls.model = [];
  state.stats = [stat('a', 'Ada'), stat('b', 'Bo'), stat('c', 'Cy')];
  state.profiles = [];
  state.participants = [{ identity_id: 'a' }, { identity_id: 'b' }];
  state.profilesToday = 0;
  modelReply = {
    model: 'claude-fable-5',
    stop_reason: 'end_turn',
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          players: [
            { player_key: 'p1', profile: 'p-ada, at a plausible length', coaching: 'c-ada, also plausibly long' },
            { player_key: 'p2', profile: 'p-bo, at a plausible length', coaching: 'c-bo, also plausibly long' }
          ]
        })
      }
    ]
  };
});

describe('auth and triggering', () => {
  it('rejects a wrong secret', async () => {
    const r = res();
    await handler({ ...ended(), headers: { 'x-webhook-secret': 'nope' } }, r);
    expect(r.code).toBe(401);
    expect(calls.model).toHaveLength(0);
  });

  it('rejects a missing secret', async () => {
    const r = res();
    await handler({ ...ended(), headers: {} }, r);
    expect(r.code).toBe(401);
  });

  it('rejects a GET', async () => {
    const r = res();
    await handler({ ...ended(), method: 'GET' }, r);
    expect(r.code).toBe(405);
  });

  // The webhook fires on every sessions UPDATE — blinds rising, the pot changing,
  // the button moving. Acting on those would call the model on every hand.
  it('ignores an update that is not a session ending', async () => {
    const r = res();
    await handler(
      { ...ended(), body: { record: { id: 'S1', status: 'active' }, old_record: { status: 'active' } } },
      r
    );
    expect(r.code).toBe(200);
    expect(r.body.skipped).toBeTruthy();
    expect(calls.model).toHaveLength(0);
  });

  // Supabase can redeliver, and an ended session can be updated again afterwards.
  it('ignores a session that was already ended before this update', async () => {
    const r = res();
    await handler({ ...ended(), body: { record: { id: 'S1', status: 'ended' }, old_record: { status: 'ended' } } }, r);
    expect(r.code).toBe(200);
    expect(calls.model).toHaveLength(0);
  });
});

describe('deciding whether to spend anything', () => {
  it('makes no model call when nobody drifted', async () => {
    state.profiles = state.stats.map((s) => ({
      identity_id: s.identity_id,
      profile: 'existing',
      stats_snapshot: { vpip_pct: 45, pfr_pct: 20, wtsd_pct: 40, af: 1.2 }
    }));
    const r = res();
    await handler(ended(), r);
    expect(calls.model).toHaveLength(0);
    expect(r.body).toMatchObject({ ok: true, rewritten: 0 });
  });

  it('refreshes the stats snapshot before reading it', async () => {
    await handler(ended(), res());
    const order = calls.db.map((c) => c.path.split('?')[0]);
    expect(order[0]).toBe('rpc/refresh_player_stats');
    expect(order.indexOf('player_stats')).toBeGreaterThan(0);
  });

  // The backstop for the day drift stops being rare — a correction to the view's
  // arithmetic, or somebody manufacturing sessions to make the webhook fire.
  it('stops rewriting once the day has hit its cap', async () => {
    state.profilesToday = 60;
    const r = res();
    await handler(ended(), r);
    expect(calls.model).toHaveLength(0);
    expect(r.code).toBe(429);
  });

  it('keeps rewriting while the day is under its cap', async () => {
    state.profilesToday = 59;
    await handler(ended(), res());
    expect(calls.model).toHaveLength(1);
  });

  // The cap costs a query; a quiet night should not even pay that.
  it('does not check the cap when nobody drifted', async () => {
    state.profiles = state.stats.map((s) => ({
      identity_id: s.identity_id,
      profile: 'existing',
      stats_snapshot: { vpip_pct: 45, pfr_pct: 20, wtsd_pct: 40, af: 1.2 }
    }));
    await handler(ended(), res());
    expect(calls.db.some((c) => c.path.startsWith('player_profiles?generated_at'))).toBe(false);
  });
});

describe('the model call', () => {
  it('sends the whole table but names only the drifted players', async () => {
    state.profiles = [
      { identity_id: 'a', profile: 'old-ada', stats_snapshot: { vpip_pct: 45, pfr_pct: 20, wtsd_pct: 40, af: 1.2 } },
      { identity_id: 'b', profile: 'old-bo', stats_snapshot: { vpip_pct: 5, pfr_pct: 20, wtsd_pct: 40, af: 1.2 } }
    ];
    await handler(ended(), res());

    expect(calls.model).toHaveLength(1);
    const sent = calls.model[0].messages[0].content;
    // Cy never played and Ada never moved; only Bo is the assignment.
    expect(sent).toContain('these players only: p2 (Bo)');
    expect(sent).not.toContain('(Ada)');
    // …but every player is present as comparison material.
    for (const name of ['Ada', 'Bo', 'Cy']) expect(sent).toContain(name);
  });

  it('passes each player their existing profile as context', async () => {
    state.profiles = [{ identity_id: 'c', profile: 'cy-is-a-rock', stats_snapshot: null }];
    await handler(ended(), res());
    expect(calls.model[0].messages[0].content).toContain('cy-is-a-rock');
  });

  it('asks for low effort and room to finish', async () => {
    await handler(ended(), res());
    expect(calls.model[0].output_config.effort).toBe('low');
    expect(calls.model[0].max_tokens).toBeGreaterThanOrEqual(32000);
  });

  it('carries the refusal fallback', async () => {
    await handler(ended(), res());
    expect(calls.model[0].fallbacks).toBe('default');
  });

  it('reports a refusal rather than storing nothing silently', async () => {
    modelReply = { model: 'x', stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] };
    const r = res();
    await handler(ended(), r);
    expect(r.code).toBe(502);
    expect(r.body).toMatchObject({ error: 'model declined', category: 'cyber' });
  });
});

describe('truncation', () => {
  // The first live run hit max_tokens mid-object. With a JSON schema in force the
  // decoder closes the structure with a minimal value, so the response still PARSES
  // — one player got a coaching note reading "x", and three never appeared at all.
  // Nothing about that looks like a failure without this check.
  it('stores nothing when the response was cut off', async () => {
    modelReply.stop_reason = 'max_tokens';
    const r = res();
    await handler(ended(), r);
    expect(r.code).toBe(502);
    expect(calls.db.find((c) => c.method === 'POST' && c.path.startsWith('player_profiles'))).toBeUndefined();
  });

  it('drops a stub entry even on an untruncated response', async () => {
    modelReply.content[0].text = JSON.stringify({
      players: [
        { player_key: 'p1', profile: 'x', coaching: 'y' },
        { player_key: 'p2', profile: 'p-bo is a long enough profile', coaching: 'c-bo is long enough too' }
      ]
    });
    const r = res();
    await handler(ended(), r);
    const rows = JSON.parse(
      calls.db.find((c) => c.method === 'POST' && c.path.startsWith('player_profiles')).body
    );
    expect(rows.map((x) => x.identity_id)).toEqual(['b']);
    expect(r.body.short_by).toBe(1);
  });
});

describe('storing the result', () => {
  it('writes a row per rewritten player, with the snapshot it was written from', async () => {
    await handler(ended(), res());
    const write = calls.db.find((c) => c.method === 'POST' && c.path.startsWith('player_profiles'));
    const rows = JSON.parse(write.body);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      identity_id: 'a',
      profile: 'p-ada, at a plausible length',
      coaching: 'c-ada, also plausibly long',
      generated_from: 'S1',
      stats_snapshot: { vpip_pct: 45, pfr_pct: 20, wtsd_pct: 40, af: 1.2 }
    });
  });

  // The model is told not to return the others; if it does anyway, storing them
  // would overwrite text that is still accurate with text nobody asked for.
  it('discards entries for players it was not asked to rewrite', async () => {
    modelReply.content[0].text = JSON.stringify({
      players: [
        { player_key: 'p1', profile: 'p-ada, at a plausible length', coaching: 'c-ada, also plausibly long' },
        { player_key: 'p3', profile: 'uninvited but long enough', coaching: 'uninvited but long enough' }
      ]
    });
    const r = res();
    await handler(ended(), r);
    const rows = JSON.parse(calls.db.find((c) => c.method === 'POST' && c.path.startsWith('player_profiles')).body);
    expect(rows.map((x) => x.identity_id)).toEqual(['a']);
    expect(r.body.rewritten).toBe(1);
  });

  it('discards a key that matches no player', async () => {
    modelReply.content[0].text = JSON.stringify({
      players: [{ player_key: 'p99', profile: 'long enough to be stored', coaching: 'long enough to be stored' }]
    });
    const r = res();
    await handler(ended(), r);
    expect(r.body.rewritten).toBe(0);
  });

  // Two identities sharing a display name is the ordinary case here — it is exactly
  // what the merge tool exists to clean up. Keyed by name, one person's profile lands
  // on the other's row; keyed by player_key, each goes where it belongs.
  it('files profiles correctly when two players share a display name', async () => {
    state.stats = [stat('a', 'Keogan'), stat('b', 'Keogan', { vpip_pct: 70 })];
    state.participants = [{ identity_id: 'a' }, { identity_id: 'b' }];
    state.profiles = [];
    modelReply.content[0].text = JSON.stringify({
      players: [
        { player_key: 'p1', profile: 'first-keogan, long enough', coaching: 'c1, long enough to keep' },
        { player_key: 'p2', profile: 'second-keogan, long enough', coaching: 'c2, long enough to keep' }
      ]
    });
    await handler(ended(), res());
    const rows = JSON.parse(
      calls.db.find((c) => c.method === 'POST' && c.path.startsWith('player_profiles')).body
    );
    expect(rows).toEqual([
      expect.objectContaining({ identity_id: 'a', profile: 'first-keogan, long enough' }),
      expect.objectContaining({ identity_id: 'b', profile: 'second-keogan, long enough' })
    ]);
  });

  it('surfaces a database failure instead of reporting success', async () => {
    state.participants = [{ identity_id: 'a' }];
    global.fetch.mockImplementationOnce(async () => ({
      ok: false,
      status: 500,
      text: async () => 'boom'
    }));
    const r = res();
    await handler(ended(), r);
    expect(r.code).toBe(500);
    expect(r.body.ok).toBe(false);
  });
});
