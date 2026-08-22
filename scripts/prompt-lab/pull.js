#!/usr/bin/env node
// Dumps real player stats to a fixture so every prompt variant is judged against
// byte-identical input. Run once; re-run only when you want fresher data.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const realNames = process.argv.includes('--real-names');

const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('Missing PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY.');
  console.error('Copy .env.local.example to .env.local and fill it in, then: npm run lab:pull');
  process.exit(1);
}

async function table(name) {
  const res = await fetch(`${url}/rest/v1/${name}?select=*`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`);
  return res.json();
}

const [lifetime, stats] = await Promise.all([table('lifetime_stats'), table('player_stats')]);

// Real names in a committed fixture would put your friends' names and poker
// tendencies in a public repo permanently. Output quality does not depend on
// them, so anonymising is the default and keeping them is the explicit choice.
const alias = new Map();
const letter = (i) => String.fromCharCode(65 + (i % 26)).repeat(Math.floor(i / 26) + 1);
[...lifetime].
  sort((a, b) => a.identity_id.localeCompare(b.identity_id))
  .forEach((p, i) => alias.set(p.identity_id, `Player ${letter(i)}`));

const nameFor = (row) => (realNames ? row.display_name : alias.get(row.identity_id) ?? 'Unknown');

const byId = new Map(stats.map((s) => [s.identity_id, s]));
const players = lifetime
  .map((p) => {
    const s = byId.get(p.identity_id) ?? {};
    const { identity_id: _drop, display_name: _drop2, ...style } = s;
    const { identity_id: _drop3, display_name: _drop4, ...lifetimeRest } = p;
    return { name: nameFor(p), lifetime: lifetimeRest, style };
  })
  // A player with no recorded hands gives the model nothing to work with, and a
  // fixture full of them makes every variant look equally bad.
  .filter((p) => (p.style.hands ?? 0) > 0)
  .sort((a, b) => (b.style.hands ?? 0) - (a.style.hands ?? 0));

if (players.length === 0) {
  console.error('No players with recorded hands. Is player_stats applied and populated?');
  process.exit(1);
}

const out = join(here, 'fixtures', realNames ? 'players.real.json' : 'players.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ pulledAt: new Date().toISOString(), players }, null, 2));
console.log(`Wrote ${players.length} player(s) → ${out}`);
if (realNames) console.log('Real names: gitignored, keep it that way.');
