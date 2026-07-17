<script lang="ts">
  import { onMount } from 'svelte';
  import { supabase } from '../lib/supabase';
  import { mergeIdentities } from '../lib/services/game';
  import type { LifetimeStat } from '../lib/types';

  type SortKey = 'total_net' | 'sessions_played' | 'biggest_win' | 'times_last';

  let stats = $state<LifetimeStat[]>([]);
  let loading = $state(true);
  let errorMsg = $state('');
  let sortBy = $state<SortKey>('total_net');

  async function loadStats() {
    // Surface failures instead of silently rendering an empty board — a missing
    // view or a permissions error looks identical to "no games yet" otherwise.
    try {
      const { data, error } = await supabase.from('lifetime_stats').select('*');
      if (error) throw error;
      stats = (data ?? []) as LifetimeStat[];
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

  onMount(loadStats);

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

  let sorted = $derived.by(() => {
    return [...stats].sort((a, b) => {
      if (sortBy === 'times_last') return a.times_last - b.times_last;
      return b[sortBy] - a[sortBy];
    });
  });

  const columns: { key: SortKey; label: string }[] = [
    { key: 'total_net', label: 'net' },
    { key: 'sessions_played', label: 'sessions' },
    { key: 'biggest_win', label: 'best win' },
    { key: 'times_last', label: 'times last' }
  ];

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
  <p class="chips-sub">Lifetime records, across every game.</p>

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
  {:else}
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
          role={mergeMode ? 'button' : undefined}
          tabindex={mergeMode ? 0 : undefined}
          onclick={mergeMode ? () => toggleSelect(player.identity_id) : undefined}
          onkeydown={mergeMode
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') toggleSelect(player.identity_id);
              }
            : undefined}
        >
          <span class="rank">{i + 1}</span>
          <span class="who">
            <span class="who-name">{player.display_name}</span>
            <span class="who-detail">
              {player.sessions_played} session{player.sessions_played === 1 ? '' : 's'}
            </span>
          </span>
          <span class="stat">
            {#if sortBy === 'total_net'}
              <span class="stat-num {netClass(player.total_net)}">{netStr(player.total_net)}</span>
              <span class="stat-label">lifetime net</span>
            {:else if sortBy === 'sessions_played'}
              <span class="stat-num">{player.sessions_played}</span>
              <span class="stat-label">sessions</span>
            {:else if sortBy === 'biggest_win'}
              <span class="stat-num {netClass(player.biggest_win)}">{netStr(player.biggest_win)}</span>
              <span class="stat-label">best session</span>
            {:else}
              <span class="stat-num net-down">{player.times_last}</span>
              <span class="stat-label">times last</span>
            {/if}
          </span>
        </li>
      {/each}
    </ul>

    <!-- Duplicate cleanup: joins from a private tab mint a fresh identity each
         visit, so the same person can appear several times. -->
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
</div>

<style>
  .sorts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0 0 2.5rem;
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

  .who-name { font-size: 1.05rem; }
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
