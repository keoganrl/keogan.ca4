<script lang="ts">
  import { onMount } from 'svelte';
  import { supabase } from '../lib/supabase';
  import { mergeIdentities } from '../lib/services/game';
  import { initIdentity, displayName } from '../lib/stores/identity';
  import {
    sortLifetimeStats,
    type LeaderboardSortKey
  } from '../lib/utils/leaderboard';
  import { buildNetSeries } from '../lib/utils/netSeries';
  import { chaosScores, MIN_CHAOS_SESSIONS } from '../lib/utils/chaos';
  import NetChart from './NetChart.svelte';
  import type { LifetimeStat, SessionResult } from '../lib/types';

  // The five stat columns are all sorts of the same lifetime board; 'chaos' is its own
  // view with its own rows, so it is a tab rather than another sort of that list.
  type Tab = LeaderboardSortKey | 'chaos';

  let stats = $state<LifetimeStat[]>([]);
  let results = $state<SessionResult[]>([]);
  let loading = $state(true);
  let errorMsg = $state('');
  let sortBy = $state<Tab>('total_net');
  // Tapping a name dims every other line — the only reliable way to pick one player
  // out once there are more than a handful on the chart.
  let highlighted = $state('');

  async function loadStats() {
    // Surface failures instead of silently rendering an empty board — a missing
    // view or a permissions error looks identical to "no games yet" otherwise.
    try {
      const [statsRes, resultsRes] = await Promise.all([
        supabase.from('lifetime_stats').select('*'),
        supabase.from('session_results').select('*')
      ]);
      if (statsRes.error) throw statsRes.error;
      stats = (statsRes.data ?? []) as LifetimeStat[];
      // The chart and chaos score are enhancements, not the board: a database that
      // predates the session_results view should still render the leaderboard rather
      // than showing everyone an error.
      if (resultsRes.error) {
        console.warn('session_results unavailable — chart and chaos hidden:', resultsRes.error);
        results = [];
      } else {
        results = (resultsRes.data ?? []) as SessionResult[];
      }
    } catch (e) {
      console.error('Leaderboard failed to load:', e);
      // Supabase returns a plain PostgrestError object (not an Error), so read
      // its message directly — that's where "relation … does not exist" etc. live.
      const msg =
        e instanceof Error ? e.message : (e as { message?: string } | null)?.message;
      errorMsg = msg || 'Could not load the leaderboard.';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    loadStats();
    // Populates $displayName from this device's saved identity — the merge tool
    // below is gated on it.
    initIdentity();
  });

  // Merging rewrites other people's history, so the tool is only offered on the
  // owner's device. Deliberately soft: the name lives in localStorage and anyone
  // who wanted to could set it, so this hides a footgun from guests rather than
  // enforcing a permission.
  const OWNER_NAME = 'keogan';
  let isOwner = $derived($displayName.trim().toLowerCase() === OWNER_NAME);

  // Merge mode: collapse duplicate identities (someone who joins from a private tab
  // gets a fresh identity every visit, so one human shows up several times). Select
  // the rows that are the same person, then pick which name survives.
  let mergeMode = $state(false);
  let selectedIds = $state<string[]>([]);
  let choosingKeep = $state(false);
  let merging = $state(false);

  const selectedStats = $derived(stats.filter((s) => selectedIds.includes(s.identity_id)));

  function toggleSelect(id: string) {
    if (choosingKeep) return;
    selectedIds = selectedIds.includes(id)
      ? selectedIds.filter((x) => x !== id)
      : [...selectedIds, id];
  }

  function exitMergeMode() {
    mergeMode = false;
    selectedIds = [];
    choosingKeep = false;
  }

  async function confirmMerge(keepId: string) {
    if (merging) return;
    merging = true;
    try {
      await mergeIdentities(
        keepId,
        selectedIds.filter((id) => id !== keepId)
      );
      await loadStats();
      exitMergeMode();
    } finally {
      merging = false;
    }
  }

  let sorted = $derived(
    sortBy === 'chaos' ? [] : sortLifetimeStats(stats, sortBy as LeaderboardSortKey)
  );
  let netData = $derived(buildNetSeries(results));
  let chaos = $derived(chaosScores(results));
  // identity_id -> the colour of that player's line, so the list doubles as the legend.
  let colorOf = $derived(
    new Map(netData.series.map((s) => [s.identityId, { color: s.color, dashed: s.dashed }]))
  );

  const columns: { key: Tab; label: string }[] = [
    { key: 'total_net', label: 'net' },
    { key: 'biggest_win', label: 'best win' },
    { key: 'times_first', label: 'times first' },
    { key: 'times_last', label: 'times last' },
    { key: 'all_ins', label: 'all-ins' },
    { key: 'chaos', label: 'chaos' }
  ];

  function toggleHighlight(id: string) {
    highlighted = highlighted === id ? '' : id;
  }

  function netClass(val: number) {
    return val > 0 ? 'net-up' : val < 0 ? 'net-down' : 'net-even';
  }

  function netStr(val: number) {
    return val > 0 ? `+${val}` : `${val}`;
  }
</script>

<div class="chips-page">
  <p class="chips-back"><a href="/chips">← chips</a></p>
  <h1 class="chips-title">Leaderboard</h1>
  <p class="chips-sub">Lifetime records across every game</p>

  <nav class="sorts">
    {#each columns as col (col.key)}
      <button class="cchoice" class:active={sortBy === col.key} onclick={() => (sortBy = col.key)}>
        {col.label}
      </button>
    {/each}
  </nav>

  {#if loading}
    <p class="cnote">Loading…</p>
  {:else if errorMsg}
    <p class="cerror">Couldn’t load the leaderboard — {errorMsg}</p>
  {:else if stats.length === 0}
    <p class="cnote">No completed sessions yet.</p>
  {:else if sortBy === 'chaos'}
    <p class="cnote explainer">Standard deviation of results across sessions</p>
    {#if chaos.length === 0}
      <p class="cnote">No completed sessions yet.</p>
    {:else}
      <ul class="board">
        {#each chaos as p, i (p.identityId)}
          <li class="board-row" class:first={i === 0 && p.qualified}>
            <span class="rank">{p.qualified ? i + 1 : '·'}</span>
            <span class="who">
              <span class="who-name">{p.displayName}</span>
              <span class="who-detail">
                {#if !p.qualified}
                  needs {MIN_CHAOS_SESSIONS - p.sessionsPlayed} more session{MIN_CHAOS_SESSIONS - p.sessionsPlayed === 1 ? '' : 's'}
                {:else}
                  best +{Math.round(p.bestSession)}bb · worst {Math.round(p.worstSession)}bb
                {/if}
              </span>
            </span>
            <span class="stat">
              <!-- The figure is the standard deviation itself, so the label gives its
                   unit rather than implying a ceiling it doesn't have. -->
              <span class="stat-num">{p.qualified ? Math.round(p.swing) : '—'}</span>
              <span class="stat-label">{p.qualified ? 'bb swing' : 'not enough data'}</span>
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  {:else}
    {#if sortBy === 'total_net' && netData.series.length > 0}
      <NetChart data={netData} {highlighted} />
    {/if}
    {#if mergeMode}
      <p class="cnote merge-hint">
        {choosingKeep
          ? 'Pick the name to keep — the others fold into it.'
          : 'Tap every entry that belongs to the same person.'}
      </p>
    {/if}
    <ul class="board">
      {#each sorted as player, i (player.identity_id)}
        <li
          class="board-row"
          class:first={i === 0 && !mergeMode}
          class:selectable={mergeMode && !choosingKeep}
          class:selected={mergeMode && selectedIds.includes(player.identity_id)}
          class:lit={!mergeMode && highlighted === player.identity_id}
        >
          <!-- The whole row is one button: a real <button> rather than a clickable <li>,
               so it is keyboard-reachable and announced correctly. Outside merge mode it
               highlights this player's line on the chart; inside it, it selects for merging. -->
          <button
            class="row-btn"
            aria-pressed={mergeMode
              ? selectedIds.includes(player.identity_id)
              : highlighted === player.identity_id}
            onclick={() =>
              mergeMode ? toggleSelect(player.identity_id) : toggleHighlight(player.identity_id)}
          >
          <span class="rank">{i + 1}</span>
          <span class="who">
            <span class="who-name">
              <!-- Only the net tab shows swatches: there they are the chart's legend and
                   carry meaning. On the other tabs there is no chart to key them to, so
                   they would be colour for its own sake. -->
              {#if sortBy === 'total_net' && colorOf.has(player.identity_id)}
                <span
                  class="swatch"
                  class:dashed={colorOf.get(player.identity_id)!.dashed}
                  style="--swatch: {colorOf.get(player.identity_id)!.color}"
                ></span>
              {/if}{player.display_name}
            </span>
            <span class="who-detail">
              {player.sessions_played} session{player.sessions_played === 1 ? '' : 's'}
            </span>
          </span>
          <span class="stat">
            {#if sortBy === 'total_net'}
              <span class="stat-num {netClass(player.total_net)}">{netStr(player.total_net)}</span>
              <span class="stat-label">lifetime net</span>
            {:else if sortBy === 'times_first'}
              <span class="stat-num net-up">{player.times_first ?? 0}</span>
              <span class="stat-label">times first</span>
            {:else if sortBy === 'biggest_win'}
              <span class="stat-num {netClass(player.biggest_win)}">{netStr(player.biggest_win)}</span>
              <span class="stat-label">best session</span>
            {:else if sortBy === 'all_ins'}
              <span class="stat-num">{player.all_ins ?? 0}</span>
              <span class="stat-label">all-ins</span>
            {:else}
              <span class="stat-num net-down">{player.times_last}</span>
              <span class="stat-label">times last</span>
            {/if}
          </span>
          </button>
        </li>
      {/each}
    </ul>

    <!-- Duplicate cleanup: joins from a private tab mint a fresh identity each
         visit, so the same person can appear several times. Owner-only — see
         isOwner above. -->
    {#if isOwner}
      <div class="merge-controls">
        {#if !mergeMode}
          {#if stats.length > 1}
            <button class="cbtn cbtn-small" onclick={() => (mergeMode = true)}>
              Merge duplicate players
            </button>
          {/if}
        {:else if choosingKeep}
          <div class="keep-picker">
            {#each selectedStats as s (s.identity_id)}
              <button
                class="cbtn"
                onclick={() => confirmMerge(s.identity_id)}
                disabled={merging}
              >
                Keep “{s.display_name}”
              </button>
            {/each}
            <button class="cbtn cbtn-small" onclick={() => (choosingKeep = false)} disabled={merging}
              >Back</button
            >
          </div>
        {:else}
          <div class="keep-picker">
            <button
              class="cbtn cbtn-primary"
              onclick={() => (choosingKeep = true)}
              disabled={selectedIds.length < 2}
            >
              Merge {selectedIds.length < 2 ? 'selected' : `${selectedIds.length} entries`}…
            </button>
            <button class="cbtn cbtn-small" onclick={exitMergeMode}>Cancel</button>
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  /* One row that scrolls sideways rather than wrapping to two. The negative margin
     cancels .chips-page's padding so the row spans the full width and a chip is clipped
     by the screen edge — that half-visible chip is the only affordance saying there is
     more to the right, so the bleed is load-bearing, not decoration. The matching
     padding keeps the first chip aligned with the text above it. */
  /* The gap the tab row leaves beneath itself. Named because .explainer cancels it
     back out, and the two have to move together. */
  .chips-page {
    --tab-gap: 2.5rem;
  }

  .sorts {
    display: flex;
    flex-wrap: nowrap;
    gap: 0.5rem;
    margin: 0 -1.75rem var(--tab-gap);
    padding-inline: 1.75rem;
    overflow-x: auto;
    /* A horizontal scroller at the edge of an iOS viewport otherwise hands the gesture
       to the browser's back-swipe halfway through a drag. */
    overscroll-behavior-x: contain;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }

  .sorts::-webkit-scrollbar {
    display: none;
  }

  /* Chips keep their natural width; without this they compress to fit instead of
     overflowing, and nothing ever scrolls. */
  .sorts :global(.cchoice) {
    flex-shrink: 0;
  }

  .board {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .board-row {
    display: flex;
    align-items: baseline;
    gap: 1rem;
    padding: 0.9rem 0;
    border-bottom: 1px solid var(--hairline);
  }

  .rank {
    font-size: 0.85rem;
    color: var(--faint);
    width: 1.5rem;
    flex-shrink: 0;
  }

  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .who-name {
    font-size: 1.05rem;
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }

  /* The list is the chart's legend: identity is never colour alone, always a swatch
     beside the name. This is also what licenses the three lighter palette slots,
     which fall under 3:1 contrast against the paper on their own. */
  .swatch {
    flex-shrink: 0;
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 50%;
    background: var(--swatch);
    /* Past the eighth player the palette repeats with a dashed stroke; the ring
       mirrors that so the swatch and its line still read as the same series. */
    box-shadow: inset 0 0 0 2px var(--paper);
  }

  .swatch:not(.dashed) {
    box-shadow: none;
  }

  /* The row button carries the layout; it must not look like a control. */
  .row-btn {
    flex: 1;
    display: flex;
    align-items: baseline;
    gap: 1rem;
    width: 100%;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .row-btn:focus-visible {
    outline: 2px solid var(--rule);
    outline-offset: 3px;
    border-radius: 3px;
  }

  .board-row.lit {
    background: var(--hairline);
    border-radius: 4px;
  }

  /* The blurb is a subtitle for the selected tab, so it sits just under the tabs —
     a shade looser than the 0.5rem .chips-sub leaves under .chips-title, because the
     tab row's rounded chips carry more visual weight than a line of text does.
     Written as a cancellation of --tab-gap rather than a bare negative value so it
     stays correct if the tab spacing changes; the negative margin collapses against
     the tab row's positive one to leave the difference. */
  .explainer {
    margin: calc(0.9rem - var(--tab-gap)) 0 1.5rem;
    max-width: 34rem;
  }
  .first .who-name {
    font-family: var(--serif-display);
    font-weight: 700;
  }

  .who-detail {
    font-size: 0.8rem;
    color: var(--faint);
  }

  .stat {
    text-align: right;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .stat-num {
    font-size: 1.15rem;
    font-weight: 700;
  }

  .stat-label {
    font-size: 0.75rem;
    color: var(--faint);
  }

  /* --- Merge mode --- */
  .merge-hint {
    margin: 0 0 1rem;
    font-style: italic;
  }
  .board-row.selectable {
    cursor: pointer;
    user-select: none;
  }
  .board-row.selected {
    background: var(--hairline);
    outline: 1px solid var(--rule);
    border-radius: 4px;
    padding-left: 0.5rem;
    padding-right: 0.5rem;
  }
  .merge-controls {
    margin-top: 2rem;
  }
  .keep-picker {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
