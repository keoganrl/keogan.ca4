<script lang="ts">
  import { onMount } from 'svelte';
  import { go } from '../lib/nav';
  import { saveIdentity, displayName, identityId, initIdentity } from '../lib/stores/identity';
  import { startSession } from '../lib/services/game';
  import { listLiveSeries, createSeries } from '../lib/services/series';
  import { isValidPrefix, buildSeriesName } from '../lib/utils/seriesName';
  import {
    generateCashEscalationSchedule,
    type CashSessionLength
  } from '../lib/utils/blindSchedule';
  import type { Series } from '../lib/types';

  // Every game is a 1000-chip cash game — no per-game stack choice.
  const BUY_IN = 1000;

  let sessionId = $state('');
  let joinCode = $state('');
  let name = $state('');
  let errorMsg = $state('');
  let loading = $state(false);

  // Blind settings — always on screen, cash-only.
  let autoEscalate = $state(true);
  let sessionMinutes = $state<CashSessionLength>(60);

  // Single or series. Single is the default because most games are one-offs, and
  // because it is the choice with no consequences: a single session keeps nothing,
  // writes nothing about anybody, and deletes itself after five days. Choosing
  // series is opting IN to a permanent record.
  let mode = $state<'single' | 'series'>('single');
  let liveSeries = $state<Series[]>([]);
  let selectedSeriesId = $state('');
  // The new-series form is only on screen while it is being used.
  let creatingSeries = $state(false);
  let prefix = $state('');
  let seriesBusy = $state(false);

  // What 'DW' would become if they made it now. Shown live under the input so the
  // month half is never a surprise — the players pick the prefix, the calendar
  // picks the rest.
  const previewName = $derived(isValidPrefix(prefix) ? buildSeriesName(prefix) : '');

  async function loadSeries() {
    try {
      liveSeries = await listLiveSeries();
    } catch (e) {
      // A database without the series table should still be able to start a game.
      // Series then simply is not on offer, which is the honest thing to show.
      console.warn('series unavailable:', e);
      liveSeries = [];
    }
  }

  async function handleCreateSeries() {
    if (seriesBusy) return;
    const name = buildSeriesName(prefix);
    seriesBusy = true;
    errorMsg = '';
    try {
      const result = await createSeries(name);
      if ('error' in result) {
        errorMsg = result.error;
        return;
      }
      // Losing the race to another phone still selects the series — someone else
      // creating the one you were creating is not a failure.
      if (!liveSeries.some((s) => s.id === result.series.id)) {
        liveSeries = [result.series, ...liveSeries];
      }
      selectedSeriesId = result.series.id;
      creatingSeries = false;
      prefix = '';
    } finally {
      seriesBusy = false;
    }
  }

  // The nine-rung doubling ladder is always built, whatever the toggle says: rung one
  // sets the opening blinds (the session length picks it), and the full ladder backs
  // the host's manual override from the schedule sheet mid-game. The toggle only
  // decides whether eliminations climb it on their own. Never edited or shown here.
  const schedule = $derived(generateCashEscalationSchedule(BUY_IN, sessionMinutes));

  const startingSmallBlind = $derived(schedule[0].small_blind);
  const startingBigBlind = $derived(schedule[0].big_blind);

  onMount(async () => {
    await initIdentity();
    const params = new URLSearchParams(window.location.search);
    sessionId = params.get('session') ?? '';
    joinCode = params.get('code') ?? '';
    name = $displayName;
    loadSeries();
  });

  async function handleStartGame() {
    loading = true;
    errorMsg = '';

    if (!name.trim()) {
      errorMsg = 'Enter your name.';
      loading = false;
      return;
    }

    // Starting "a series game" with no series would quietly become a single game —
    // no leaderboard, and gone in five days. Refuse rather than surprise them.
    if (mode === 'series' && !selectedSeriesId) {
      errorMsg = 'Choose a series, or start a single session.';
      loading = false;
      return;
    }

    await saveIdentity(name.trim());

    try {
      await startSession(
        sessionId,
        $identityId,
        name.trim(),
        BUY_IN,
        startingSmallBlind,
        startingBigBlind,
        'cash',
        schedule,
        autoEscalate,
        mode === 'series' ? selectedSeriesId : null
      );
      go(`/table?session=${sessionId}`);
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : 'Failed to start game.';
      loading = false;
    }
  }
</script>

<div class="chips-page">
  <p class="chips-back"><a href="/chips">← chips</a></p>
  <h1 class="chips-title">New game</h1>
  <p class="chips-sub">Table code — <span class="chips-code">{joinCode}</span></p>

  <div class="cfield">
    <input
      id="setup-name"
      bind:value={name}
      placeholder="Your name"
      maxlength="40"
      autocomplete="name"
      aria-label="Your name"
    />
  </div>

  <!-- Single or series. Above the blind settings because it is the choice that
       decides what the session IS, not how it plays. -->
  <div class="group">
    <span class="clabel">Session type</span>
    <div class="choices">
      <button
        class="cchoice grow"
        class:active={mode === 'single'}
        onclick={() => (mode = 'single')}>Single</button
      >
      <button
        class="cchoice grow"
        class:active={mode === 'series'}
        onclick={() => (mode = 'series')}>Series</button
      >
    </div>

    {#if mode === 'single'}
      <p class="cnote type-note">
        Results at the end, then nothing kept. No leaderboard.
      </p>
    {:else}
      <div class="series-picker">
        {#each liveSeries as s (s.id)}
          <button
            class="cchoice series-option"
            class:active={selectedSeriesId === s.id}
            onclick={() => {
              selectedSeriesId = s.id;
              creatingSeries = false;
            }}>{s.name}</button
          >
        {/each}

        {#if creatingSeries}
          <div class="new-series">
            <input
              class="cinput prefix-input"
              bind:value={prefix}
              placeholder="DW"
              maxlength="5"
              aria-label="Series prefix, 2 to 5 letters"
              autocapitalize="characters"
              autocomplete="off"
              onkeydown={(e) => e.key === 'Enter' && previewName && handleCreateSeries()}
            />
            <button
              class="cbtn"
              disabled={!previewName || seriesBusy}
              onclick={handleCreateSeries}>Create</button
            >
            <button class="cbtn ghost" onclick={() => (creatingSeries = false)}>Cancel</button>
          </div>
          <p class="cnote type-note">
            {#if previewName}
              Will be called <span class="chips-code">{previewName}</span>
            {:else}
              Two to five letters. The month is added automatically.
            {/if}
          </p>
        {:else}
          <button class="cchoice series-option new" onclick={() => (creatingSeries = true)}>
            + New series
          </button>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Blind settings — always on screen, no disclosure. -->
  <div class="group">
    <div class="subgroup">
      <span class="clabel">Session length</span>
      <div class="choices">
        {#each [[60, '1h'] as const, [120, '2h'] as const, [180, '3h+'] as const] as [mins, label] (mins)}
          <button
            class="cchoice grow"
            class:active={sessionMinutes === mins}
            onclick={() => (sessionMinutes = mins)}>{label}</button
          >
        {/each}
      </div>
    </div>

    <label class="cswitch escalation-toggle">
      <input type="checkbox" bind:checked={autoEscalate} />
      <span class="track" aria-hidden="true"></span>
      Double blinds when someone busts
    </label>
  </div>

  {#if errorMsg}
    <p class="cerror">{errorMsg}</p>
  {/if}

  <button class="cbtn cbtn-primary cbtn-block start" onclick={handleStartGame} disabled={loading}>
    {loading ? 'Starting…' : 'Start the game'}
  </button>
</div>

<style>
  .group {
    margin-bottom: 2rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .subgroup {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .grow { flex: 1; }

  /* A touch more air between the session-length row and the toggle. */
  .escalation-toggle { margin-top: 1rem; }

  /* The consequence of the choice above it, so it sits tight under the buttons. */
  .type-note {
    margin: 0.15rem 0 0;
    font-size: 0.8rem;
  }

  .series-picker {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }

  /* Series names are the content here, so let them size themselves rather than
     splitting the row evenly the way the session-length buttons do. */
  .series-option {
    flex: 0 1 auto;
  }
  .series-option.new {
    font-style: italic;
  }

  .new-series {
    display: flex;
    gap: 0.5rem;
    align-items: flex-end;
    width: 100%;
  }

  .prefix-input {
    flex: 1;
    letter-spacing: 0.3em;
    text-transform: uppercase;
    text-align: center;
  }
  .prefix-input::placeholder {
    letter-spacing: 0.3em;
  }

  .ghost {
    opacity: 0.7;
  }

  .start {
    font-size: 1.05rem;
    padding: 0.8rem 1.2rem;
    margin-top: 0.5rem;
  }
</style>
