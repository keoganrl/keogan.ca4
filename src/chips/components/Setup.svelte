<script lang="ts">
  import { onMount } from 'svelte';
  import { go } from '../lib/nav';
  import { saveIdentity, displayName, identityId, initIdentity } from '../lib/stores/identity';
  import { startSession } from '../lib/services/game';
  import {
    generateCashEscalationSchedule,
    type CashSessionLength
  } from '../lib/utils/blindSchedule';

  // Every game is a 1000-chip cash game — no per-game stack choice.
  const BUY_IN = 1000;

  let sessionId = $state('');
  let joinCode = $state('');
  let name = $state('');
  let errorMsg = $state('');
  let loading = $state(false);

  // Blind settings — always on screen, cash-only.
  let enableEscalation = $state(true);
  let sessionMinutes = $state<CashSessionLength>(60);

  // A fixed nine-step ladder runs quietly in the background: enough rungs for any
  // table, climbed only as players leave. Never edited or shown here.
  const schedule = $derived(
    enableEscalation ? generateCashEscalationSchedule(BUY_IN, sessionMinutes) : []
  );

  const startingSmallBlind = $derived(schedule.length > 0 ? schedule[0].small_blind : 1);
  const startingBigBlind = $derived(schedule.length > 0 ? schedule[0].big_blind : 2);

  onMount(async () => {
    await initIdentity();
    const params = new URLSearchParams(window.location.search);
    sessionId = params.get('session') ?? '';
    joinCode = params.get('code') ?? '';
    name = $displayName;
  });

  async function handleStartGame() {
    loading = true;
    errorMsg = '';

    if (!name.trim()) {
      errorMsg = 'Enter your name.';
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
        schedule
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
      <input type="checkbox" bind:checked={enableEscalation} />
      <span class="track" aria-hidden="true"></span>
      Raise blinds as players leave
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

  .start {
    font-size: 1.05rem;
    padding: 0.8rem 1.2rem;
    margin-top: 0.5rem;
  }
</style>
