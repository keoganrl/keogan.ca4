<script lang="ts">
  import { onMount } from 'svelte';
  import { supabase } from '../lib/supabase';
  import type { LifetimeStat } from '../lib/types';

  type SortKey = 'total_net' | 'sessions_played' | 'biggest_win' | 'times_last';

  let stats = $state<LifetimeStat[]>([]);
  let loading = $state(true);
  let sortBy = $state<SortKey>('total_net');

  onMount(async () => {
    const { data } = await supabase.from('lifetime_stats').select('*');
    if (data) stats = data as LifetimeStat[];
    loading = false;
  });

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
  {:else if stats.length === 0}
    <p class="cnote">No completed sessions yet.</p>
  {:else}
    <ul class="board">
      {#each sorted as player, i (player.identity_id)}
        <li class="board-row" class:first={i === 0}>
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
</style>
