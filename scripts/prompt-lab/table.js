#!/usr/bin/env node
// Prints the live player_stats as a markdown table, ready to paste into a Claude
// chat with whatever prompt you are trying. This is the fastest way to iterate on
// voice: no key, no fixture, no waiting on a harness. run.js is for the later job
// of comparing variants and reps head to head.
// Defaults to the site's own published Supabase settings so this works with no
// setup at all. That is not a leaked secret: the anon key is a PUBLISHABLE key by
// design, it is compiled into the JavaScript keogan.ca serves to every visitor, and
// the tables it reaches are the same wide-open ones the leaderboard already reads
// in the browser. .env.local overrides both if you ever rotate them.
const url = process.env.PUBLIC_SUPABASE_URL || 'https://lonrwoytqkmdmbwlunwm.supabase.co';
const key = process.env.PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable_NRnG8J6_buUtf5aCp_hTMg_1RCaC4pF';

const COLUMNS = [
  ['display_name', 'display_name'],
  ['hands', 'hands'],
  ['reliability', 'reliability'],
  ['vpip_pct', 'vpip_pct'],
  ['pfr_pct', 'pfr_pct'],
  ['af', 'af'],
  ['cbet_flop_pct', 'cbet_flop_pct'],
  ['cbet_opps', 'cbet_opps'],
  ['steal_pct', 'steal_pct'],
  ['steal_opps', 'steal_opps'],
  ['wtsd_pct', 'wtsd_pct']
];

const res = await fetch(`${url}/rest/v1/player_stats?select=*&order=hands.desc`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` }
});
if (!res.ok) {
  console.error(`player_stats: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const rows = await res.json();

const cell = (v) => (v === null || v === undefined ? 'null' : String(v));
const widths = COLUMNS.map(([label, k]) =>
  Math.max(label.length, ...rows.map((r) => cell(r[k]).length))
);
const line = (cells) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;

console.log(line(COLUMNS.map(([label]) => label)));
console.log(line(widths.map((w) => '-'.repeat(w))));
for (const r of rows) console.log(line(COLUMNS.map(([, k]) => cell(r[k]))));
