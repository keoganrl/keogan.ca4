<script lang="ts">
  import { onMount } from 'svelte';
  import { listAllSeries } from '../lib/services/series';
  import { seriesLeaderboardHref } from '../lib/nav';
  import type { Series } from '../lib/types';

  interface Props {
    /**
     * Series that have an archive committed to the repo, collected at build time.
     * They render before the database has answered, and they are still there if it
     * never does — an ended series' board is static HTML, so it would be strange
     * for the list pointing at it to need Supabase to be up.
     */
    archived?: { name: string; endedAt: string | null }[];
  }

  let { archived = [] }: Props = $props();

  let live = $state<Series[]>([]);
  let ended = $state<{ name: string; endedAt: string | null }[]>(archived);
  let loading = $state(true);
  let errorMsg = $state('');

  onMount(async () => {
    try {
      const all = await listAllSeries();
      live = all.filter((s) => s.status === 'live');

      // Database rows win over the build-time list where both know a series, since
      // they carry the real ended_at; anything only the build knows about is kept.
      const fromDb = all
        .filter((s) => s.status === 'ended')
        .map((s) => ({ name: s.name, endedAt: s.ended_at }));
      const seen = new Set(fromDb.map((s) => s.name));
      ended = [...fromDb, ...archived.filter((a) => !seen.has(a.name))].sort((a, b) =>
        b.name.localeCompare(a.name)
      );
    } catch (e) {
      console.warn('series list unavailable:', e);
      // The archived list still stands on its own, so this is only an error if
      // there is nothing at all to show.
      if (archived.length === 0) errorMsg = 'Could not load the series list.';
    } finally {
      loading = false;
    }
  });
</script>

<div class="chips-page">
  <p class="chips-back"><a href="/chips">← chips</a></p>
  <h1 class="chips-title">Leaderboards</h1>
  <p class="chips-sub">One board per series</p>

  {#if loading && ended.length === 0}
    <p class="cnote">Loading…</p>
  {:else if errorMsg}
    <p class="cerror">{errorMsg}</p>
  {:else if live.length === 0 && ended.length === 0}
    <p class="cnote">No series yet. Start one from the new game screen.</p>
  {:else}
    {#if live.length > 0}
      <h2 class="group-title">Running</h2>
      <ul class="series-list">
        {#each live as s (s.id)}
          <li>
            <a class="series-row" href={seriesLeaderboardHref(s.name)}>
              <span class="series-name">{s.name}</span>
              <span class="series-note">in progress</span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}

    {#if ended.length > 0}
      <h2 class="group-title">Finished</h2>
      <ul class="series-list">
        {#each ended as s (s.name)}
          <li>
            <a class="series-row" href={seriesLeaderboardHref(s.name)}>
              <span class="series-name">{s.name}</span>
              <span class="series-note">
                {s.endedAt ? `ended ${new Date(s.endedAt).toLocaleDateString()}` : 'ended'}
              </span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .group-title {
    font-size: 0.8rem;
    text-transform: lowercase;
    letter-spacing: 0.08em;
    color: var(--faint);
    font-weight: 400;
    margin: 2rem 0 0.5rem;
  }

  .series-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .series-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.9rem 0;
    border-bottom: 1px solid var(--hairline);
    text-decoration: none;
    color: inherit;
  }

  /* The name is the thing being chosen, so it carries the display face the rest of
     the app gives to a result rather than a label. */
  .series-name {
    font-family: var(--serif-display);
    font-size: 1.05rem;
  }

  .series-note {
    font-size: 0.8rem;
    color: var(--faint);
    flex-shrink: 0;
  }
</style>
