// Ending a series: freeze its leaderboard, then delete the data behind it.
//
// Run from the repo root:
//   node --env-file-if-exists=.env.local scripts/end-series.mjs DW-2026-07
//   node --env-file-if-exists=.env.local scripts/end-series.mjs DW-2026-07 \
//     --confirm --confirm-name=DW-2026-07
//
// ############################################################################
// THIS IS ONE OF TWO PLACES IN THE REPO ALLOWED TO DELETE /chips DATA. The other
// is the purge in api/keep-alive.js. Read this header before changing anything.
//
// players, rebuys, hands, events and session_recaps all declare ON DELETE CASCADE
// on sessions, so deleting one session row takes its entire ledger with it. There
// is no undo and no soft delete anywhere in this schema.
//
// The two phases are separate invocations ON PURPOSE. There is deliberately no
// single command that archives and deletes, because the archive is not proven by
// having been written — it is proven by being deployed and looked at. Between the
// two runs a human commits the snapshot, waits for Vercel, opens the frozen board
// and compares it to the live one. Phase two refuses until that has had a chance
// to happen, and it refuses again if anything about the archive looks wrong.
//
// If you are unsure, stop after phase one. A series marked `ended` with its rows
// still in the database is a perfectly stable state: it takes no new sessions, its
// board still renders, and nothing has been lost. The only irreversible step is
// phase two, and it is never urgent.
// ############################################################################
//
// The full runbook, including where the raw dump has to go before phase two, is in
// README.md under "Ending a series".
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { db, json } from '../api/_supabase.js';

const ARCHIVE_DIR = 'src/chips/archive';
const BACKUP_DIR = 'backups';

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--'));
const confirm = args.includes('--confirm');
const confirmName = args.find((a) => a.startsWith('--confirm-name='))?.split('=')[1];

const die = (msg) => {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
};

if (!name) {
  die('Usage: end-series.mjs <SERIES-NAME> [--confirm --confirm-name=<SERIES-NAME>]');
}
if (!process.env.PUBLIC_SUPABASE_URL) {
  die('PUBLIC_SUPABASE_URL is not set. Run with --env-file-if-exists=.env.local.');
}

const archivePath = `${ARCHIVE_DIR}/${name}.json`;

// Which project this is about to act on, printed before anything happens. The whole
// failure mode this guards against is running it against the wrong database, and by
// the time you notice, phase two has already cascaded.
const projectRef = process.env.PUBLIC_SUPABASE_URL.replace(/^https?:\/\//, '').split('.')[0];
const usingServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

async function counts(seriesId) {
  const sessions = await json(`sessions?select=id&series_id=eq.${seriesId}`);
  const ids = sessions.map((s) => s.id);
  if (ids.length === 0) return { ids, players: 0, events: 0 };
  const inList = `in.(${ids.join(',')})`;
  const [players, events] = await Promise.all([
    json(`players?select=id&session_id=${inList}`),
    json(`events?select=id&session_id=${inList}`),
  ]);
  return { ids, players: players.length, events: events.length };
}

async function loadSeries() {
  const [series] = await json(`series?select=*&name=eq.${encodeURIComponent(name)}`);
  if (!series) die(`No series called "${name}".`);
  return series;
}

// ------------------------------------------------------------------ phase one

async function archive() {
  const series = await loadSeries();
  const before = await counts(series.id);

  console.log(`\n  Supabase project : ${projectRef}`);
  console.log(`  Key              : ${usingServiceRole ? 'service role' : 'publishable'}`);
  console.log(`  Series           : ${series.name} (${series.status})`);
  console.log(`  Sessions         : ${before.ids.length}`);
  console.log(`  Player rows      : ${before.players}`);
  console.log(`  Ledger events    : ${before.events}\n`);

  if (before.ids.length === 0) {
    die('That series has no sessions. Nothing to archive, and nothing worth ending.');
  }

  // Marked ended FIRST, and this is the only write phase one makes. It closes the
  // series to new sessions so nothing can join between here and the snapshot, and it
  // is reversible: set status back to 'live' if you change your mind.
  if (series.status !== 'ended') {
    const r = await db(`series?id=eq.${series.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'ended', ended_at: new Date().toISOString() }),
    });
    if (!r.ok) die(`Could not mark the series ended: ${r.status} ${await r.text()}`);
    console.log('  ✓ Marked ended — no new sessions can join it.');
  } else {
    console.log('  · Already marked ended.');
  }

  const endedAt = (await loadSeries()).ended_at;

  const [stats, results, allProfiles, allPlayerStats] = await Promise.all([
    json(`lifetime_stats?select=*&series_id=eq.${series.id}`),
    json(`session_results?select=*&series_id=eq.${series.id}`),
    json('player_profiles?select=*'),
    json('player_stats?select=*'),
  ]);

  // player_profiles and player_stats are keyed by identity and span every series, so
  // they are narrowed to the people who actually played in this one.
  const here = new Set(stats.map((s) => s.identity_id));

  const archiveDoc = {
    name: series.name,
    endedAt,
    stats,
    results,
    // `coaching` is dropped deliberately. It is written to be read by the player it
    // is about, and this file is committed to a public repository. The frozen board
    // renders profiles and the detailed stats panel without it. The full text is in
    // the raw dump below, which is gitignored.
    profiles: allProfiles
      .filter((p) => here.has(p.identity_id))
      .map(({ identity_id, profile, generated_at }) => ({ identity_id, profile, generated_at })),
    playerStats: allPlayerStats.filter((s) => here.has(s.identity_id)),
  };

  mkdirSync(ARCHIVE_DIR, { recursive: true });
  writeFileSync(archivePath, JSON.stringify(archiveDoc, null, 2) + '\n');
  console.log(`  ✓ Archive written  → ${archivePath}`);

  // The raw dump. The archive above renders the board; this is what would let the
  // series be RECONSTRUCTED, and phase two refuses to run without it. Gitignored,
  // because it holds the whole ledger and everyone's coaching text.
  const inList = `in.(${before.ids.join(',')})`;
  const [sessions, players, rebuys, hands, events, recaps] = await Promise.all([
    json(`sessions?select=*&series_id=eq.${series.id}`),
    json(`players?select=*&session_id=${inList}`),
    json(`rebuys?select=*&session_id=${inList}`),
    json(`hands?select=*&session_id=${inList}`),
    json(`events?select=*&session_id=${inList}&order=seq`),
    json(`session_recaps?select=*&session_id=${inList}`),
  ]);

  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${BACKUP_DIR}/${series.name}-${stamp}.json`;
  writeFileSync(
    backupPath,
    JSON.stringify(
      {
        series,
        takenAt: new Date().toISOString(),
        projectRef,
        sessions,
        players,
        rebuys,
        hands,
        events,
        session_recaps: recaps,
        player_profiles: allProfiles.filter((p) => here.has(p.identity_id)),
      },
      null,
      2
    ) + '\n'
  );
  console.log(`  ✓ Raw dump written → ${backupPath}`);

  console.log(`
  Nothing has been deleted. Next:

    1. Move ${backupPath} somewhere off this machine — it is the only full copy.
    2. git add ${archivePath} && commit && push, then wait for the Vercel deploy.
    3. Open https://keogan.ca/chips/${series.name}/leaderboard and check every tab
       against the live board. They must match.
    4. Only then:
       node --env-file-if-exists=.env.local scripts/end-series.mjs ${series.name} \\
         --confirm --confirm-name=${series.name}
`);
}

// ------------------------------------------------------------------ phase two

async function wipe() {
  // Local checks first, deliberately: they cost nothing, they are the ones most
  // likely to fire, and there is no reason to touch the database to discover that
  // somebody forgot --confirm-name.
  if (confirmName !== name) {
    die(`Pass --confirm-name=${name} to confirm. Deleting is not undoable.`);
  }
  if (!existsSync(archivePath)) {
    die(`No archive at ${archivePath}. Run phase one first.`);
  }

  let archiveDoc;
  try {
    archiveDoc = JSON.parse(readFileSync(archivePath, 'utf8'));
  } catch (e) {
    die(`${archivePath} does not parse: ${e.message}`);
  }
  if (!archiveDoc.stats?.length) {
    die(`${archivePath} holds no standings. Refusing to delete a series it cannot show.`);
  }

  // Keyed off the CLI argument, not a database row: this check is one of the local
  // ones, and it has to run before the network for the same reason the others do.
  const backups = existsSync(BACKUP_DIR)
    ? readdirSync(BACKUP_DIR).filter((f) => f.startsWith(`${name}-`))
    : [];
  if (backups.length === 0) {
    die(
      `No raw dump in ${BACKUP_DIR}/ for ${name}. That file is the only thing that ` +
        `could rebuild this series. Run phase one again.`
    );
  }

  const series = await loadSeries();
  if (series.status !== 'ended') {
    die('That series is not marked ended. Run phase one first.');
  }

  const before = await counts(series.id);
  if (before.ids.length === 0) {
    console.log('\n  · No sessions left in that series. Already wiped.\n');
    return;
  }

  // The archive has to describe the database that is about to be deleted. If it does
  // not, it was taken from something else — a different series, or this one before
  // more was played — and the board that survives would be wrong.
  const archivedSessions = new Set(archiveDoc.results.map((r) => r.session_id));
  const missing = [...archivedSessions].filter((id) => !before.ids.includes(id));
  if (missing.length > 0) {
    die(
      `The archive names ${missing.length} session(s) the database does not have. ` +
        `It was not taken from this series as it stands. Re-run phase one.`
    );
  }

  const totalBefore = (await json('sessions?select=id')).length;

  console.log(`\n  Supabase project : ${projectRef}`);
  console.log(`  Key              : ${usingServiceRole ? 'service role' : 'publishable'}`);
  console.log(`  Deleting         : ${before.ids.length} sessions from ${series.name}`);
  console.log(`  Cascading        : ${before.players} player rows, ${before.events} events,`);
  console.log('                     plus their rebuys, hands and recaps.\n');

  // By explicit id list, never by the series_id filter. A filter that loses its
  // parameter in transit matches every session ever played; a list of ids cannot.
  const r = await db(`sessions?id=in.(${before.ids.join(',')})`, { method: 'DELETE' });
  if (!r.ok) die(`Delete failed: ${r.status} ${await r.text()}`);

  const after = await counts(series.id);
  if (after.ids.length !== 0) {
    die(`${after.ids.length} sessions remain. Stop and look before doing anything else.`);
  }

  // Nothing outside the series should have moved.
  const totalAfter = (await json('sessions?select=id')).length;
  const expected = totalBefore - before.ids.length;
  if (totalAfter !== expected) {
    die(
      `Session count is ${totalAfter}, expected ${expected}. Something outside ` +
        `${series.name} was affected. Stop and restore from the raw dump.`
    );
  }

  // player_stats is a MATERIALIZED view: until it is refreshed it still holds rows
  // derived from sessions that no longer exist, so the live profiles tab would show
  // hand counts for a series that has been wiped. endSession only refreshes it when
  // a game ends, so this is the one place it has to be explicit.
  const refresh = await db('rpc/refresh_player_stats', { method: 'POST', body: '{}' });
  if (!refresh.ok) {
    console.warn(`  ! refresh_player_stats failed (${refresh.status}). Run it by hand.`);
  }

  console.log(`  ✓ ${series.name} deleted. ${totalAfter} sessions remain in total.`);
  console.log(`  ✓ The frozen board still renders from ${archivePath}.\n`);
}

try {
  await (confirm ? wipe() : archive());
} catch (e) {
  // A thrown error here is almost always the database saying no — a missing table on
  // a project that has not had the migrations, or the wrong key. Say so plainly
  // rather than printing a stack over a half-finished protocol.
  die(e.message);
}
