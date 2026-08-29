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
import { db, json, countOf } from './_supabase.js';

const MODEL = 'claude-opus-5';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A session someone fabricated to burn tokens would have to have real seats and
// real dealt hands. Cheap to check, and it turns "spend money on demand" into
// "play a whole game of poker first".
//
// Worth being honest about how much that is worth: the chips tables are
// anon-writable by design, so a determined stranger with the publishable key can
// manufacture a session that passes these checks. What they cannot do is get past
// DAILY_CAP below, which is the control that actually bounds the money.
const MIN_PLAYERS = 2;
const MIN_HANDS = 5;

// Most recaps ever written in one day, across every session. The group plays one
// session a night, so this is roughly twenty times normal use and will never be
// reached by playing poker. It is a ceiling on a bad day, not a quota.
const DAILY_CAP = 20;

// A claim older than this is treated as dead and taken over. The claim row is what
// stops two phones on the game-over screen paying for the same paragraph twice, and
// recap.js deletes its own claim when a generation fails — but a function that is
// killed outright (a timeout, a crash between the claim and the delete) never gets
// to run that cleanup, and the null row it leaves behind would answer "already
// generating" to every future visit, forever. Generation takes a few seconds, so
// anything still unfinished after three minutes is not coming back.
const CLAIM_TIMEOUT_MS = 3 * 60 * 1000;



export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const sessionId = req.body?.sessionId;
  if (!sessionId || !UUID.test(sessionId)) {
    return res.status(400).json({ error: 'bad session id' });
  }

  try {
    const [session] = await json(`sessions?select=id,status,series_id&id=eq.${sessionId}`);
    if (!session) return res.status(404).json({ error: 'no such session' });
    if (session.status !== 'ended') {
      return res.status(409).json({ error: 'session has not ended' });
    }
    // Single sessions get no recap. They keep nothing, so there is nothing for a
    // paragraph to be part of — and the session itself is deleted after five days.
    //
    // This sits ABOVE the claim and above the daily counter on purpose, and both
    // positions matter. Above the claim, so a one-off never leaves a session_recaps
    // row behind for a recap that is never coming. Above the counter, because
    // DAILY_CAP is twenty a day across EVERY session: one-off nights drawing on it
    // would starve the series play it exists for, and the cap is one of the three
    // things that actually bound the money.
    //
    // The client does not call this for single sessions either, but that gate is a
    // courtesy. This endpoint is reachable without a secret, so its preconditions
    // are the only real ones it has.
    if (!session.series_id) {
      return res.status(422).json({ error: 'single sessions get no recap' });
    }

    // Already written: hand back the stored copy. This is what makes the endpoint
    // idempotent, and it is also the spend cap — one generation per session, ever.
    const [existing] = await json(`session_recaps?select=*&session_id=eq.${sessionId}`);
    if (existing?.recap) {
      return res.status(200).json({ recap: existing.recap, cached: true });
    }
    if (existing) {
      const claimedAt = Date.parse(existing.claimed_at ?? '');
      // Claimed but not finished: another screen is generating it right now.
      if (Number.isFinite(claimedAt) && Date.now() - claimedAt < CLAIM_TIMEOUT_MS) {
        return res.status(202).json({ error: 'already generating' });
      }
      // Old enough that whoever claimed it is never coming back. Clear the corpse and
      // fall through to claim it ourselves.
      await db(`session_recaps?session_id=eq.${sessionId}`, { method: 'DELETE' });
    }

    const [playerCount, handCount] = await Promise.all([
      countOf(`players?session_id=eq.${sessionId}`),
      countOf(`events?session_id=eq.${sessionId}&type=eq.deal`),
    ]);
    if (playerCount < MIN_PLAYERS || handCount < MIN_HANDS) {
      return res.status(422).json({ error: 'not enough of a game to write about' });
    }

    // The spend ceiling, and the only check here that a fabricated session cannot walk
    // around: it counts what has actually been generated today rather than anything
    // about the caller. Note it counts claims, not just finished recaps, so failed
    // attempts that did reach the model still count against the day.
    const today = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const spentToday = await countOf(`session_recaps?claimed_at=gte.${today}`, 'session_id');
    if (spentToday >= DAILY_CAP) {
      return res.status(429).json({ error: 'daily recap limit reached' });
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

    const client = new Anthropic();
    let text = '';

    const request = (fast) => ({
      model: MODEL,
      max_tokens: 1000,
      ...(fast ? { speed: 'fast' } : {}),
      betas: [
        ...(fast ? ['fast-mode-2026-02-01'] : []),
        'server-side-fallback-2026-07-01',
      ],
      fallbacks: 'default',
      // Low effort on purpose: this is a short creative paragraph, not a reasoning
      // problem, and thinking time here is dead air on the screen.
      output_config: { effort: 'low' },
      system: `${SHARED}\n\n---\n\n${RECAP}`,
      messages: [
        {
          role: 'user',
          content: `Results for the session that just finished, best to worst:\n\n${JSON.stringify(tonight, null, 2)}`,
        },
      ],
    });

    try {
      // Fast mode roughly doubles output speed for about a cent on a paragraph, and
      // this is the one place in the app where a room of people is watching text
      // appear. It is also a research preview that is OFF for most organisations,
      // and an org without it does not get slower output, it gets a hard 429 naming
      // a limit of zero. So it is opt-in through the environment, and a rate limit
      // falls back to standard speed rather than losing the recap.
      let stream;
      try {
        stream = await client.beta.messages.stream(request(process.env.FAST_MODE === '1'));
      } catch (e) {
        if (e?.status !== 429) throw e;
        stream = await client.beta.messages.stream(request(false));
      }

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          if (!text) {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
          }
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
