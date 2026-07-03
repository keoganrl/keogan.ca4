<script lang="ts">
  import { onMount } from 'svelte';
  import { go } from '../lib/nav';
  import { saveIdentity, displayName, identityId, initIdentity } from '../lib/stores/identity';
  import { startSession } from '../lib/services/game';
  import {
    generateTournamentSchedule,
    generateCashEscalationSchedule,
    suggestCashBlinds,
    type Pace,
    type CashSessionLength
  } from '../lib/utils/blindSchedule';
  import type { BlindLevel, GameMode } from '../lib/types';

  let sessionId = $state('');
  let joinCode = $state('');
  let name = $state('');
  let buyIn = $state(1000);
  let errorMsg = $state('');
  let loading = $state(false);

  // Blind settings state
  let showBlindSettings = $state(false);
  let numPlayers = $state(6);
  let gameMode = $state<GameMode>('cash');
  let enableEscalation = $state(false);
  let sessionMinutes = $state<CashSessionLength>(120);
  let pace = $state<Pace>('normal');
  let editableSchedule = $state<BlindLevel[]>([]);

  // Auto-generate schedule whenever relevant inputs change
  $effect(() => {
    if (gameMode === 'tournament') {
      editableSchedule = generateTournamentSchedule(buyIn, numPlayers, sessionMinutes, pace);
    } else if (enableEscalation) {
      editableSchedule = generateCashEscalationSchedule(buyIn, numPlayers, sessionMinutes);
    } else {
      editableSchedule = [];
    }
  });

  // Starting blinds come from schedule[0] when active, else manual inputs
  let smallBlind = $state(1);
  let bigBlind = $state(2);

  const suggestedCashBlindsValue = $derived(suggestCashBlinds(buyIn, sessionMinutes));

  // No "Apply" step: the blind inputs track the stack/session-length suggestion live.
  // The host can still type custom blinds — they stick until an option changes.
  $effect(() => {
    if (gameMode === 'cash') {
      [smallBlind, bigBlind] = suggestedCashBlindsValue;
    }
  });

  const startingSmallBlind = $derived(
    editableSchedule.length > 0 ? editableSchedule[0].small_blind : smallBlind
  );
  const startingBigBlind = $derived(
    editableSchedule.length > 0 ? editableSchedule[0].big_blind : bigBlind
  );

  const totalScheduleMinutes = $derived(
    editableSchedule.reduce((acc, l) => acc + l.duration_minutes, 0)
  );

  function addLevel() {
    const last = editableSchedule[editableSchedule.length - 1];
    const newSb = last ? last.small_blind * 2 : smallBlind;
    const newBb = last ? last.big_blind * 2 : bigBlind;
    const dur = gameMode === 'tournament' ? (last?.duration_minutes ?? 20) : 0;
    editableSchedule = [
      ...editableSchedule,
      {
        level: editableSchedule.length + 1,
        small_blind: newSb,
        big_blind: newBb,
        duration_minutes: dur
      }
    ];
  }

  function removeLevel(idx: number) {
    editableSchedule = editableSchedule
      .filter((_, i) => i !== idx)
      .map((l, i) => ({ ...l, level: i + 1 }));
  }

  function updateLevel(idx: number, field: keyof BlindLevel, raw: string) {
    const val = parseInt(raw, 10);
    if (isNaN(val) || val < 0) return;
    editableSchedule = editableSchedule.map((l, i) => (i === idx ? { ...l, [field]: val } : l));
  }

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
        buyIn,
        startingSmallBlind,
        startingBigBlind,
        gameMode,
        editableSchedule
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
    <label for="setup-name">Your name</label>
    <input id="setup-name" bind:value={name} maxlength="40" autocomplete="name" />
  </div>

  <!-- Buy-in -->
  <div class="group">
    <p class="clabel">Starting stack — everyone who joins gets this</p>
    <div class="choices">
      {#each [100, 200, 500, 1000] as amount (amount)}
        <button class="cchoice" class:active={buyIn === amount} onclick={() => (buyIn = amount)}>
          {amount}
        </button>
      {/each}
    </div>
  </div>

  <!-- Blind settings -->
  <div class="group">
    <button class="disclosure" onclick={() => (showBlindSettings = !showBlindSettings)}>
      {showBlindSettings ? '▾' : '▸'} blind settings
    </button>

    {#if showBlindSettings}
      <div class="panel">
        <!-- Expected players -->
        <div class="row-between">
          <span class="clabel">Expected players</span>
          <div class="stepper">
            <button class="cstep" onclick={() => (numPlayers = Math.max(2, numPlayers - 1))}
              >−</button
            >
            <span class="stepper-value">{numPlayers}</span>
            <button class="cstep" onclick={() => (numPlayers = Math.min(10, numPlayers + 1))}
              >+</button
            >
          </div>
        </div>

        <!-- Mode toggle -->
        <div class="choices">
          {#each [['cash', 'cash'] as const, ['tournament', 'tournament'] as const] as [val, label] (val)}
            <button
              class="cchoice grow"
              class:active={gameMode === val}
              onclick={() => {
                gameMode = val;
                enableEscalation = false;
              }}>{label}</button
            >
          {/each}
        </div>

        <!-- Cash mode options -->
        {#if gameMode === 'cash'}
          <!-- Session length picker: shorter sessions get bigger blinds. Always shown —
               with escalation on, it sets the ladder's base blinds. -->
          <div class="subgroup">
            <span class="clabel">Session length</span>
            <div class="choices">
              {#each [[60, '1h'] as const, [120, '2h'] as const, [180, '3h'] as const, [240, '4h+'] as const] as [mins, label] (mins)}
                <button
                  class="cchoice grow"
                  class:active={sessionMinutes === mins}
                  onclick={() => (sessionMinutes = mins)}>{label}</button
                >
              {/each}
            </div>
            <p class="cnote">
              ~{Math.round(buyIn / suggestedCashBlindsValue[1])} big-blind stacks at
              {suggestedCashBlindsValue[0]}/{suggestedCashBlindsValue[1]}
            </p>
          </div>

          <label class="cswitch">
            <input type="checkbox" bind:checked={enableEscalation} />
            <span class="track" aria-hidden="true"></span>
            Raise blinds as players leave
          </label>
        {/if}

        <!-- Tournament: session length + pace -->
        {#if gameMode === 'tournament'}
          <div class="subgroup">
            <span class="clabel">Session length</span>
            <div class="choices">
              {#each [[60, '1h'], [120, '2h'], [180, '3h'], [240, '4h+']] as [mins, label] (mins)}
                <button
                  class="cchoice grow"
                  class:active={sessionMinutes === mins}
                  onclick={() => (sessionMinutes = mins as CashSessionLength)}>{label}</button
                >
              {/each}
            </div>
          </div>
          <div class="subgroup">
            <span class="clabel">Pace</span>
            <div class="choices">
              {#each [['turbo', 'turbo'] as const, ['normal', 'normal'] as const, ['deep', 'deep'] as const] as [val, label] (val)}
                <button class="cchoice grow" class:active={pace === val} onclick={() => (pace = val)}
                  >{label}</button
                >
              {/each}
            </div>
          </div>
        {/if}

        <!-- Schedule editor (tournament or cash escalation) -->
        {#if editableSchedule.length > 0}
          <div class="subgroup">
            <div class="row-between">
              <span class="clabel">
                {gameMode === 'tournament' ? 'Schedule' : 'Escalation ladder'}
              </span>
              {#if gameMode === 'tournament' && totalScheduleMinutes > 0}
                <span class="cnote">
                  total {Math.floor(totalScheduleMinutes / 60)}h {totalScheduleMinutes % 60 > 0
                    ? `${totalScheduleMinutes % 60}m`
                    : ''}
                </span>
              {/if}
            </div>

            <div class="sched" class:with-minutes={gameMode === 'tournament'}>
              <span class="sched-head">#</span>
              <span class="sched-head">small</span>
              <span class="sched-head">big</span>
              {#if gameMode === 'tournament'}<span class="sched-head">min</span>{/if}
              <span></span>

              {#each editableSchedule as level, i (i)}
                <span class="sched-num">{level.level}</span>
                <input
                  class="cinput cinput-num"
                  type="number"
                  value={level.small_blind}
                  oninput={(e) => updateLevel(i, 'small_blind', (e.target as HTMLInputElement).value)}
                  min="1"
                />
                <input
                  class="cinput cinput-num"
                  type="number"
                  value={level.big_blind}
                  oninput={(e) => updateLevel(i, 'big_blind', (e.target as HTMLInputElement).value)}
                  min="1"
                />
                {#if gameMode === 'tournament'}
                  <input
                    class="cinput cinput-num"
                    type="number"
                    value={level.duration_minutes}
                    oninput={(e) =>
                      updateLevel(i, 'duration_minutes', (e.target as HTMLInputElement).value)}
                    min="1"
                  />
                {/if}
                <button class="sched-remove" onclick={() => removeLevel(i)} aria-label="Remove level"
                  >×</button
                >
              {/each}
            </div>

            <button class="cbtn cbtn-small cbtn-block" onclick={addLevel}>+ add level</button>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Manual blind inputs — only for fixed cash (no schedule) -->
  {#if editableSchedule.length === 0}
    <div class="group">
      <p class="clabel">Blinds</p>
      <div class="blinds-row">
        <div class="blind">
          <span class="clabel">small</span>
          <input class="cinput cinput-num" type="number" bind:value={smallBlind} min="1" />
        </div>
        <span class="blind-slash">/</span>
        <div class="blind">
          <span class="clabel">big</span>
          <input class="cinput cinput-num" type="number" bind:value={bigBlind} min="1" />
        </div>
      </div>
    </div>
  {/if}

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

  .disclosure {
    font-family: inherit;
    font-size: 0.9rem;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--faint);
    text-align: left;
    transition: color 1s ease;
  }

  .panel {
    border-top: 1px solid var(--hairline);
    border-bottom: 1px solid var(--hairline);
    padding: 1.25rem 0;
    display: flex;
    flex-direction: column;
    gap: 1.4rem;
  }

  .row-between {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .stepper {
    display: flex;
    align-items: center;
    gap: 0.85rem;
  }
  .stepper-value {
    font-weight: 700;
    min-width: 1.25rem;
    text-align: center;
  }

  .sched {
    display: grid;
    grid-template-columns: 1.5rem 1fr 1fr 1.5rem;
    gap: 0.5rem 0.75rem;
    align-items: baseline;
  }
  .sched.with-minutes {
    grid-template-columns: 1.5rem 1fr 1fr 2.75rem 1.5rem;
  }

  .sched-head {
    font-size: 0.75rem;
    color: var(--whisper);
    text-align: center;
  }
  .sched-head:first-child { text-align: right; }

  .sched-num {
    font-size: 0.8rem;
    color: var(--faint);
    text-align: right;
  }

  .sched-remove {
    font-family: inherit;
    font-size: 1.1rem;
    line-height: 1;
    background: none;
    border: none;
    color: var(--whisper);
    cursor: pointer;
    padding: 0;
    transition: color 1s ease;
  }

  .blinds-row {
    display: flex;
    align-items: flex-end;
    gap: 1rem;
  }
  .blind {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    align-items: center;
  }
  .blind .clabel { align-self: center; }
  .blind-slash {
    color: var(--whisper);
    padding-bottom: 0.25rem;
  }

  .start {
    font-size: 1.05rem;
    padding: 0.8rem 1.2rem;
    margin-top: 0.5rem;
  }

  @media (hover: hover) and (pointer: fine) {
    .disclosure:hover {
      color: var(--ink);
      transition: color 0.1s ease;
    }
    .sched-remove:hover {
      color: var(--down);
      transition: color 0.1s ease;
    }
  }
</style>
