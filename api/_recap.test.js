import { describe, it, expect, vi, beforeEach } from 'vitest';

// This endpoint is reachable from any browser, so most of what matters is what it
// REFUSES to do. Each guard gets a test, because a regression in one of them turns
// a public URL into a way to spend the owner's money.
const calls = { db: [], model: [] };
let streamChunks = ['A ', 'good ', 'night.'];
let modelBehaviour = () => {};
let finalMessage = { stop_reason: 'end_turn' };

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    beta = {
      messages: {
        stream: async (args) => {
          calls.model.push(args);
          modelBehaviour();
          return {
            async *[Symbol.asyncIterator]() {
              for (const text of streamChunks) {
                yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
              }
            },
            finalMessage: async () => finalMessage
          };
        }
      }
    };
  }
}));

const state = {
  session: { id: 'S', status: 'ended' },
  recapRow: null,
  players: 4,
  hands: 20,
  claimOk: true
};

global.fetch = vi.fn(async (url, init = {}) => {
  const path = String(url).split('/rest/v1/')[1];
  calls.db.push({ path, method: init.method ?? 'GET', body: init.body });
  // text(), not json(): the shared helper reads bodies as text so it can tolerate
  // the empty one PostgREST returns from a write.
  const ok = (data, headers = {}) => ({
    ok: true,
    status: 200,
    text: async () => (data === null ? '' : JSON.stringify(data)),
    json: async () => data,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null }
  });
  const counting = init.headers?.Prefer === 'count=exact';
  if (path.startsWith('sessions?')) return ok(state.session ? [state.session] : []);
  if (path.startsWith('session_recaps?select')) return ok(state.recapRow ? [state.recapRow] : []);
  if (path.startsWith('players?') && counting)
    return ok([], { 'content-range': `0-0/${state.players}` });
  if (path.startsWith('events?') && counting)
    return ok([], { 'content-range': `0-0/${state.hands}` });
  if (path.startsWith('players?'))
    return ok([{ display_name: 'Ada', stack: 300, total_buyin: 100, identity_id: 'a' }]);
  if (path.startsWith('player_profiles')) return ok([{ identity_id: 'a', profile: 'calls a lot' }]);
  if (path === 'session_recaps' && init.method === 'POST')
    return state.claimOk ? ok(null) : { ok: false, status: 409, text: async () => 'conflict' };
  if (path.startsWith('session_recaps')) return ok([]);
  return { ok: false, status: 404, text: async () => 'unknown' };
});

const { default: handler } = await import('./recap.js');

const ID = '11111111-2222-3333-4444-555555555555';

function res() {
  const r = { code: 200, body: null, written: '', headers: {}, ended: false, headersSent: false };
  r.status = (c) => ((r.code = c), r);
  r.json = (b) => ((r.body = b), r);
  r.setHeader = (k, v) => (r.headers[k] = v);
  r.write = (chunk) => ((r.written += chunk), (r.headersSent = true), true);
  r.end = () => ((r.ended = true), r);
  return r;
}

const req = (over = {}) => ({ method: 'POST', body: { sessionId: ID }, ...over });

beforeEach(() => {
  process.env.PUBLIC_SUPABASE_URL = 'https://db.test';
  process.env.PUBLIC_SUPABASE_ANON_KEY = 'anon';
  calls.db = [];
  calls.model = [];
  state.session = { id: ID, status: 'ended' };
  state.recapRow = null;
  state.players = 4;
  state.hands = 20;
  state.claimOk = true;
  streamChunks = ['A ', 'good ', 'night.'];
  finalMessage = { stop_reason: 'end_turn' };
  modelBehaviour = () => {};
  delete process.env.FAST_MODE;
});

describe('what it refuses', () => {
  it('rejects a GET', async () => {
    const r = res();
    await handler(req({ method: 'GET' }), r);
    expect(r.code).toBe(405);
    expect(calls.model).toHaveLength(0);
  });

  it('rejects anything that is not a uuid', async () => {
    for (const bad of ['', 'abc', "' or 1=1--", '../../etc', null]) {
      const r = res();
      await handler(req({ body: { sessionId: bad } }), r);
      expect(r.code, String(bad)).toBe(400);
    }
    expect(calls.model).toHaveLength(0);
  });

  it('rejects a session that does not exist', async () => {
    state.session = null;
    const r = res();
    await handler(req(), r);
    expect(r.code).toBe(404);
    expect(calls.model).toHaveLength(0);
  });

  // Otherwise a live game could be made to generate a recap over and over as it runs.
  it('rejects a session that has not ended', async () => {
    state.session = { id: ID, status: 'active' };
    const r = res();
    await handler(req(), r);
    expect(r.code).toBe(409);
    expect(calls.model).toHaveLength(0);
  });

  // The spend cap: an ended session can only ever produce one generation.
  it('returns the stored recap instead of writing a second one', async () => {
    state.recapRow = { session_id: ID, recap: 'already written' };
    const r = res();
    await handler(req(), r);
    expect(r.body).toEqual({ recap: 'already written', cached: true });
    expect(calls.model).toHaveLength(0);
  });

  it('does not start a second generation while one is in flight', async () => {
    state.recapRow = { session_id: ID, recap: null };
    const r = res();
    await handler(req(), r);
    expect(r.code).toBe(202);
    expect(calls.model).toHaveLength(0);
  });

  it('loses the claim race gracefully rather than generating twice', async () => {
    state.claimOk = false;
    const r = res();
    await handler(req(), r);
    expect(r.code).toBe(202);
    expect(calls.model).toHaveLength(0);
  });

  // A fabricated session is cheap to make; a fabricated session with seats and
  // twenty dealt hands is a whole game of poker.
  it('refuses a session with too few players', async () => {
    state.players = 1;
    const r = res();
    await handler(req(), r);
    expect(r.code).toBe(422);
    expect(calls.model).toHaveLength(0);
  });

  it('refuses a session with too few hands', async () => {
    state.hands = 2;
    const r = res();
    await handler(req(), r);
    expect(r.code).toBe(422);
    expect(calls.model).toHaveLength(0);
  });
});

describe('the happy path', () => {
  it('streams the text out as it arrives', async () => {
    const r = res();
    await handler(req(), r);
    expect(r.written).toBe('A good night.');
    expect(r.ended).toBe(true);
  });

  it('stores what it streamed', async () => {
    const r = res();
    await handler(req(), r);
    const patch = calls.db.find((c) => c.method === 'PATCH');
    expect(JSON.parse(patch.body).recap).toBe('A good night.');
  });

  it('asks for low effort on Opus, and no fast mode unless enabled', async () => {
    const sent = (await handler(req(), res()), calls.model[0]);
    expect(sent.output_config.effort).toBe('low');
    expect(sent.model).toBe('claude-opus-5');
    expect(sent.speed).toBeUndefined();
    expect(sent.betas).not.toContain('fast-mode-2026-02-01');
  });

  it('asks for fast mode when the environment enables it', async () => {
    process.env.FAST_MODE = '1';
    await handler(req(), res());
    expect(calls.model[0].speed).toBe('fast');
    expect(calls.model[0].betas).toContain('fast-mode-2026-02-01');
  });

  // Fast mode is a research preview. An org without it does not get slower output,
  // it gets a hard 429 naming a limit of zero — which lost the recap entirely the
  // first time this ran live.
  it('falls back to standard speed when fast mode is rate limited', async () => {
    process.env.FAST_MODE = '1';
    let first = true;
    modelBehaviour = () => {
      if (first) {
        first = false;
        const e = new Error('429 rate_limit_error: 0 fast mode input tokens');
        e.status = 429;
        throw e;
      }
    };
    const r = res();
    await handler(req(), r);
    expect(calls.model).toHaveLength(2);
    expect(calls.model[0].speed).toBe('fast');
    expect(calls.model[1].speed).toBeUndefined();
    expect(r.written).toBe('A good night.');
  });

  it('gives the model tonight\'s results and the players\' profiles', async () => {
    await handler(req(), res());
    const content = calls.model[0].messages[0].content;
    expect(content).toContain('Ada');
    expect(content).toContain('calls a lot');
  });
});

describe('when generation fails', () => {
  it('releases its claim so the next visit can retry', async () => {
    streamChunks = [];
    finalMessage = { stop_reason: 'refusal' };
    const r = res();
    await handler(req(), r);
    const del = calls.db.find((c) => c.method === 'DELETE');
    expect(del).toBeTruthy();
    expect(del.path).toContain(ID);
  });

  it('never stores an empty recap', async () => {
    streamChunks = ['   '];
    finalMessage = { stop_reason: 'end_turn' };
    await handler(req(), res());
    expect(calls.db.find((c) => c.method === 'PATCH')).toBeUndefined();
  });
});
