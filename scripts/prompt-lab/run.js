#!/usr/bin/env node
// Runs every prompt variant against every fixture player and writes one HTML page
// with the results side by side. Reading 18 blocks of prose in a terminal is how
// prompt iteration stalls out; a comparison you can scan in a browser is the
// whole point of this script.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const here = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const kind = arg('kind', 'profile');
const model = arg('model', 'claude-fable-5');
const reps = Number(arg('reps', 2));
const limit = Number(arg('players', 0));

// Real names win if you pulled them, then your anonymised pull, then the shipped
// synthetic sample so the lab runs before you have pulled anything.
const candidates = ['players.real.json', 'players.json', 'players.example.json'].map((f) =>
  join(here, 'fixtures', f)
);
const path = candidates.find(existsSync);
if (!path) {
  console.error('No fixture. Run pull.js first.');
  process.exit(1);
}
if (path.endsWith('players.example.json')) {
  console.warn('Using the synthetic sample fixture — run pull.js for your real data.');
}
const fixture = JSON.parse(readFileSync(path, 'utf8'));
const players = limit ? fixture.players.slice(0, limit) : fixture.players;

// One house prompt shared by every kind — voice, the group, the standing rules —
// so a change to how the app talks is made once rather than in each variant. Task
// instructions come after it, and win where they overlap.
const sharedPath = join(here, 'prompts', '_shared.md');
const shared = existsSync(sharedPath) ? readFileSync(sharedPath, 'utf8').trim() : '';

// Leading-underscore files are shared fragments, not variants, and the kind- prefix
// already excludes them; kept explicit so a future _notes.md cannot become a column.
const variants = readdirSync(join(here, 'prompts'))
  .filter((f) => !f.startsWith('_'))
  .filter((f) => f.startsWith(`${kind}-`) && f.endsWith('.md'))
  .map((f) => ({ name: f.replace(/\.md$/, ''), text: readFileSync(join(here, 'prompts', f), 'utf8') }));

if (variants.length === 0) {
  console.error(`No prompts/${kind}-*.md files.`);
  process.exit(1);
}

const client = new Anthropic();

async function generate(variant, player) {
  const body = shared ? `${shared}\n\n---\n\n${variant.text}` : variant.text;
  const system = body.replace('{{STATS}}', JSON.stringify(player, null, 2));
  try {
    const res = await client.beta.messages.create({
      model,
      max_tokens: 2000,
      system,
      // Fable 5 can decline outright rather than throwing; roast-adjacent copy about
      // named people is exactly the shape that occasionally trips a classifier. The
      // fallback re-runs the same request on Opus 5 inside the same call, and costs
      // nothing on the runs where it never fires.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content: 'Write it.' }]
    });
    if (res.stop_reason === 'refusal') {
      return { text: `[refused: ${res.stop_details?.category ?? 'unknown'}]`, refused: true };
    }
    const text = res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return { text, servedBy: res.model, usage: res.usage };
  } catch (e) {
    return { text: `[error: ${e.message}]`, error: true };
  }
}

console.log(`${variants.length} variant(s) × ${players.length} player(s) × ${reps} rep(s) on ${model}`);

const jobs = [];
for (const player of players) {
  for (const variant of variants) {
    for (let rep = 0; rep < reps; rep++) {
      jobs.push({ player, variant, rep });
    }
  }
}

const results = await Promise.all(
  jobs.map(async (job) => ({ ...job, result: await generate(job.variant, job.player) }))
);

const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

const cells = (player) =>
  variants
    .map((v) => {
      const runs = results.filter((r) => r.player === player && r.variant === v);
      return `<td>${runs
        .map((r) => `<div class="run"><span class="rep">rep ${r.rep + 1}</span><p>${esc(r.result.text)}</p></div>`)
        .join('')}</td>`;
    })
    .join('');

const html = `<!doctype html><meta charset="utf-8">
<title>prompt lab — ${esc(kind)}</title>
<style>
  body { font: 16px/1.55 Georgia, serif; margin: 2rem auto; max-width: 1400px; padding: 0 1rem;
         color: #2a2a2a; background: #fdfbf7; }
  h1 { font-size: 1.3rem; } .meta { color: #888; font-size: .85rem; }
  /* Fixed layout, or the browser sizes columns by content and one variant ends up
     three times the width of another — which reads as a difference between the
     prompts when it is only a difference in how much they happened to write. */
  table { border-collapse: collapse; width: 100%; margin-top: 1.5rem; table-layout: fixed; }
  th, td { border: 1px solid #e6e2da; padding: .8rem; vertical-align: top;
           width: ${(88 / variants.length).toFixed(2)}%; }
  th { background: #f5f1e8; font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; }
  th.who, td.who { width: 12%; } td.who { font-weight: bold; }
  .run + .run { margin-top: .9rem; padding-top: .9rem; border-top: 1px dashed #ddd; }
  .rep { display: block; font-size: .7rem; color: #aaa; text-transform: uppercase; letter-spacing: .08em; }
  p { margin: .3rem 0 0; white-space: pre-wrap; }
</style>
<h1>prompt lab — ${esc(kind)}</h1>
<p class="meta">${esc(model)} · ${reps} rep(s) · fixture pulled ${esc(fixture.pulledAt)}<br>
Read down a column for one prompt's consistency; read across for the real comparison.
${reps > 1 ? 'If the reps within a cell disagree more than the columns do, you are looking at noise.' : 'Single rep — you cannot tell a prompt difference from run-to-run variance here.'}</p>
<table>
  <tr><th class="who">player</th>${variants.map((v) => `<th>${esc(v.name)}</th>`).join('')}</tr>
  ${players.map((p) => `<tr><td class="who">${esc(p.name)}<br><span class="meta">${p.style.hands} hands</span></td>${cells(p)}</tr>`).join('')}
</table>`;

const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.html`);
writeFileSync(out, html);

const refused = results.filter((r) => r.result.refused).length;
const errored = results.filter((r) => r.result.error).length;
console.log(`Wrote ${out}`);
if (refused) console.log(`${refused} refusal(s) — the fallback did not rescue those.`);
if (errored) console.log(`${errored} error(s) — see the page.`);
