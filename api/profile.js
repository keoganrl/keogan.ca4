// Supabase database webhook target: fires when a session's status becomes 'ended'
// and refreshes the generated player profiles. Native Vercel function (matches
// notify.js) — Astro's static output doesn't deploy src/pages/api routes.
//
// Most nights this makes NO model call at all. It refreshes the stats snapshot,
// compares each player's current figures to the ones their existing profile was
// written from, and returns early if nobody has moved. A profile that rewrote
// itself every session would mean nothing; the cost of a quiet night should be
// zero, and is.
//
// When someone has moved, every player's stats and every current profile go in a
// SINGLE call, with only the drifted players named for rewriting. The rest are
// context, deliberately: the funniest lines are comparisons ("the only person here
// who seems to know raising is legal"), and those only exist if the model can see
// the whole table.
import Anthropic from '@anthropic-ai/sdk';
import { selectForRewrite, snapshotOf } from './_drift.js';
import { SHARED, PROFILE, COACHING } from './_prompts.js';

const MODEL = 'claude-fable-5';

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.PROFILE_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // The webhook fires on any sessions UPDATE, so most calls are not a session
  // ending — a blind level rising, the pot changing, the button moving. Only act
  // on the transition INTO 'ended', or every hand of every game triggers this.
  const record = req.body?.record;
  const before = req.body?.old_record;
  if (!record?.id || record.status !== 'ended' || before?.status === 'ended') {
    return res.status(200).json({ ok: true, skipped: 'not a session ending' });
  }

  try {
    // The snapshot is what everything below reads, and endSession's own refresh is
    // fire-and-forget on the client — it may have failed, or raced this webhook.
    // Refreshing here costs ~70ms and makes the endpoint correct on its own.
    await json('rpc/refresh_player_stats', { method: 'POST', body: '{}' });

    const [stats, profiles, participants] = await Promise.all([
      json('player_stats?select=*&order=hands.desc'),
      json('player_profiles?select=*'),
      json(`players?select=identity_id&session_id=eq.${record.id}`),
    ]);

    const participantIds = [...new Set(participants.map((p) => p.identity_id).filter(Boolean))];
    const rewrite = selectForRewrite({ stats, profiles, participantIds });

    if (rewrite.length === 0) {
      return res.status(200).json({ ok: true, rewritten: 0, reason: 'nobody drifted' });
    }

    const byId = new Map(profiles.map((p) => [p.identity_id, p]));
    const table = stats.map((s) => ({
      ...s,
      current_profile: byId.get(s.identity_id)?.profile ?? null,
    }));

    const names = stats
      .filter((s) => rewrite.includes(s.identity_id))
      .map((s) => s.display_name);

    const client = new Anthropic();
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      // Roast-adjacent copy about named people is exactly the shape that can trip a
      // classifier, and Fable declines by returning stop_reason rather than throwing.
      // The fallback re-runs the same request on another model inside this call, so
      // a decline costs a moment rather than the night's profiles.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: `${SHARED}\n\n---\n\n${PROFILE}\n\n---\n\n${COACHING}`,
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['players'],
            properties: {
              players: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['display_name', 'profile', 'coaching'],
                  properties: {
                    display_name: { type: 'string' },
                    profile: { type: 'string' },
                    coaching: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      messages: [
        {
          role: 'user',
          content:
            `Here is the whole table. Every player's numbers, and the profile they ` +
            `currently have where one exists:\n\n${JSON.stringify(table, null, 2)}\n\n` +
            `Write a new profile AND a new coaching note for these players only: ` +
            `${names.join(', ')}.\n\n` +
            `Everyone else is here so you can compare — comparisons are the best part ` +
            `— but do not return entries for them.`,
        },
      ],
    });

    if (response.stop_reason === 'refusal') {
      return res.status(502).json({
        ok: false,
        error: 'model declined',
        category: response.stop_details?.category ?? null,
      });
    }

    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const written = JSON.parse(text).players ?? [];

    // Match on display_name because that is what the model was given and what it
    // echoes back; identity_id never leaves the server.
    const idByName = new Map(stats.map((s) => [s.display_name, s.identity_id]));
    const rows = written
      .map((w) => {
        const identityId = idByName.get(w.display_name);
        if (!identityId || !rewrite.includes(identityId)) return null;
        const stat = stats.find((s) => s.identity_id === identityId);
        return {
          identity_id: identityId,
          profile: w.profile,
          coaching: w.coaching,
          stats_snapshot: snapshotOf(stat),
          generated_from: record.id,
          generated_at: new Date().toISOString(),
        };
      })
      .filter(Boolean);

    if (rows.length > 0) {
      await json('player_profiles?on_conflict=identity_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify(rows),
      });
    }

    return res.status(200).json({
      ok: true,
      rewritten: rows.length,
      asked_for: rewrite.length,
      served_by: response.model,
    });
  } catch (e) {
    // Detail in the body, as notify.js does: Vercel's function logs are where this
    // gets diagnosed, and a bare 500 there tells you nothing.
    return res.status(500).json({ ok: false, error: e.message });
  }
}
