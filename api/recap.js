// Streams the game-over recap to the screen everyone is standing around.
//
// Unlike api/profile.js this is reachable from a browser, because the recap has to
// appear WHILE people are looking at it — a spinner then a sudden paragraph reads
// far worse than words arriving as they are written. That means no shared secret is
// possible, so the protection is structural instead: the only thing this endpoint
// will write about is a session that already exists, has genuinely been played, has
// ended, and has no recap yet. Everything it can be made to do, it can be made to
// do exactly once per real game.
import Anthropic from '@anthropic-ai/sdk';
import { SHARED, RECAP } from './_prompts.js';

const MODEL = 'claude-opus-5';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A session someone fabricated to burn tokens would have to have real seats and
// real dealt hands. Cheap to check, and it turns "spend money on demand" into
// "play a whole game of poker first".
const MIN_PLAYERS = 2;
const MIN_HANDS = 5;

const db = (path, init = {}) =>
  fetch(`${process.env.PUBLIC_SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: process.env.PUBLIC_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${process.env.PUBLIC_SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });

async function json(path, init) {
  const r = await db(path, init);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

async function countOf(path) {
  const r = await db(`${path}&select=id&limit=1`, { headers: { Prefer: 'count=exact' } });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  // content-range comes back as "0-0/12"; the total is what we want.
  return Number(r.headers.get('content-range')?.split('/')[1] ?? 0);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const sessionId = req.body?.sessionId;
  if (!sessionId || !UUID.test(sessionId)) {
    return res.status(400).json({ error: 'bad session id' });
  }

  try {
    const [session] = await json(`sessions?select=id,status&id=eq.${sessionId}`);
    if (!session) return res.status(404).json({ error: 'no such session' });
    if (session.status !== 'ended') {
      return res.status(409).json({ error: 'session has not ended' });
    }

    // Already written: hand back the stored copy. This is what makes the endpoint
    // idempotent, and it is also the spend cap — one generation per session, ever.
    const [existing] = await json(`session_recaps?select=*&session_id=eq.${sessionId}`);
    if (existing?.recap) {
      return res.status(200).json({ recap: existing.recap, cached: true });
    }
    if (existing) {
      // Claimed but not finished: another screen is generating it right now.
      return res.status(202).json({ error: 'already generating' });
    }

    const [playerCount, handCount] = await Promise.all([
      countOf(`players?session_id=eq.${sessionId}`),
      countOf(`events?session_id=eq.${sessionId}&type=eq.deal`),
    ]);
    if (playerCount < MIN_PLAYERS || handCount < MIN_HANDS) {
      return res.status(422).json({ error: 'not enough of a game to write about' });
    }

    // Claim before generating. The primary key on session_id means a second request
    // arriving at the same moment loses this insert and takes the 202 above, rather
    // than paying for a duplicate.
    const claim = await db('session_recaps', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId }),
    });
    if (!claim.ok) {
      return res.status(202).json({ error: 'already generating' });
    }

    const [players, profiles] = await Promise.all([
      json(`players?select=display_name,stack,total_buyin,identity_id&session_id=eq.${sessionId}`),
      json('player_profiles?select=identity_id,profile'),
    ]);

    const profileOf = new Map(profiles.map((p) => [p.identity_id, p.profile]));
    const tonight = players
      .map((p) => ({
        name: p.display_name,
        bought_in: p.total_buyin,
        finished: p.stack,
        net: p.stack - p.total_buyin,
        profile: profileOf.get(p.identity_id) ?? null,
      }))
      .sort((a, b) => b.net - a.net);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');

    const client = new Anthropic();
    let text = '';

    try {
      const stream = await client.beta.messages.stream({
        model: MODEL,
        max_tokens: 1000,
        // Fast mode roughly doubles output speed for about a cent extra on a
        // paragraph. This is the one place in the app where generation latency is
        // watched by a room of people, so it is worth paying for here and nowhere
        // else. Opus-only, which is why the model above is not Fable.
        speed: 'fast',
        betas: ['fast-mode-2026-02-01', 'server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        // Low effort on purpose: this is a short creative paragraph, not a reasoning
        // problem, and thinking time here is dead air on the screen.
        output_config: { effort: 'low' },
        system: `${SHARED}\n\n---\n\n${RECAP}`,
        messages: [
          {
            role: 'user',
            content: `Tonight's results, best to worst:\n\n${JSON.stringify(tonight, null, 2)}`,
          },
        ],
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          text += event.delta.text;
          res.write(event.delta.text);
        }
      }

      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal' || !text.trim()) {
        throw new Error(`no usable text (${final.stop_reason})`);
      }
    } catch (e) {
      // Release the claim so the next visit to this screen can try again, rather
      // than leaving a null row that blocks the recap forever.
      await db(`session_recaps?session_id=eq.${sessionId}`, { method: 'DELETE' });
      if (!res.headersSent) return res.status(500).json({ error: e.message });
      res.end();
      return;
    }

    await db(`session_recaps?session_id=eq.${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ recap: text, generated_at: new Date().toISOString() }),
    });

    return res.end();
  } catch (e) {
    if (res.headersSent) return res.end();
    return res.status(500).json({ error: e.message });
  }
}
