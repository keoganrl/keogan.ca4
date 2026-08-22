<script lang="ts">
  import { onMount } from 'svelte';
  import { go } from '../lib/nav';
  import { supabase } from '../lib/supabase';
  import { netResult, netColor } from '../lib/utils/format';
  import type { Player } from '../lib/types';

  let sessionId = $state('');
  let players = $state<Player[]>([]);
  let loading = $state(true);

  // The recap streams in while everyone is still looking at the screen. Failure is
  // silent by design: this is a bonus paragraph over the results, and an error
  // message where a joke should be is worse than no paragraph at all.
  let recap = $state('');
  let recapDone = $state(false);

  async function streamRecap(id: string) {
    try {
      const r = await fetch('/api/recap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: id })
      });

      // A recap written earlier — or one another screen is mid-way through — comes
      // back as JSON rather than a stream.
      if (r.headers.get('content-type')?.includes('application/json')) {
        const body = await r.json();
        if (body.recap) {
          recap = body.recap;
        }
        recapDone = true;
        return;
      }
      if (!r.ok || !r.body) {
        recapDone = true;
        return;
      }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        recap += decoder.decode(value, { stream: true });
      }
    } catch (e) {
      console.warn('recap unavailable:', e);
    } finally {
      recapDone = true;
    }
  }

  onMount(async () => {
    const params = new URLSearchParams(window.location.search);
    sessionId = params.get('session') ?? '';
    if (!sessionId) {
      go('/');
      return;
    }

    const { data } = await supabase
      .from('players')
      .select('*')
      .eq('session_id', sessionId)
      .order('stack', { ascending: false });

    if (data) players = data as Player[];
    loading = false;

    // Not awaited: the results are the page and must not wait on a paragraph.
    streamRecap(sessionId);
  });
</script>

<div class="chips-page">
  <p class="chips-back"><a href="/chips">← chips</a></p>
  <h1 class="chips-title">Game over</h1>
  <p class="chips-sub">Final results</p>

  {#if loading}
    <p class="cnote">Loading…</p>
  {:else}
    {#if recap || !recapDone}
      <!-- aria-live so a screen reader announces the text once it settles rather
           than reading each streamed fragment as it lands. -->
      <p class="recap" class:writing={!recapDone} aria-live="polite" aria-busy={!recapDone}>
        {recap}
      </p>
    {/if}

    <ul class="results">
      {#each players as player, i (player.id)}
        <li class="result-row" class:first={i === 0}>
          <span class="rank">{i + 1}</span>
          <span class="who">
            <span class="who-name">{player.display_name}</span>
            <span class="who-detail">bought in {player.total_buyin} · finished {player.stack}</span>
          </span>
          <span class="net {netColor(player.stack, player.total_buyin)}">
            {netResult(player.stack, player.total_buyin)}
          </span>
        </li>
      {/each}
    </ul>

    <div class="actions">
      <a class="cbtn" href="/chips">Home</a>
      <a class="cbtn" href="/chips/leaderboard">Leaderboard</a>
    </div>
  {/if}
</div>

<style>
  .recap {
    max-width: 34rem;
    margin: 0 0 2rem;
    color: var(--ink-soft);
  }

  /* A caret while text is still arriving, so a pause reads as "still writing"
     rather than "finished, and that was it". */
  .recap.writing::after {
    content: '';
    display: inline-block;
    width: 0.5ch;
    height: 1em;
    margin-left: 0.15em;
    vertical-align: text-bottom;
    background: var(--rule);
    animation: recap-caret 1s steps(2, start) infinite;
  }

  @keyframes recap-caret {
    50% {
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .recap.writing::after {
      animation: none;
    }
  }

  .results {
    list-style: none;
    padding: 0;
    margin: 0 0 3rem;
  }

  .result-row {
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

  .net {
    font-size: 1.15rem;
    font-weight: 700;
    flex-shrink: 0;
  }

  .actions {
    display: flex;
    gap: 0.75rem;
  }
  .actions a {
    text-decoration: none;
    text-align: center;
    flex: 1;
  }
</style>
