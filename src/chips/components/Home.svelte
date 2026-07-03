<script lang="ts">
  import { onMount } from 'svelte';
  import { go } from '../lib/nav';
  import { initIdentity, displayName } from '../lib/stores/identity';
  import { normalizeCode } from '../lib/utils/joinCode';
  import { createGame, findGameByCode } from '../lib/services/game';

  let joinCode = $state('');
  let errorMsg = $state('');
  let loading = $state(false);

  onMount(() => {
    initIdentity();
  });

  async function handleCreateGame() {
    loading = true;
    errorMsg = '';
    try {
      const game = await createGame();
      go(`/setup?session=${game.id}&code=${game.join_code}`);
    } catch {
      errorMsg = 'Failed to create game. Check your connection.';
      loading = false;
    }
  }

  async function handleJoinGame() {
    loading = true;
    errorMsg = '';
    const code = normalizeCode(joinCode);

    if (!code) {
      errorMsg = 'Enter a join code.';
      loading = false;
      return;
    }

    const game = await findGameByCode(code);
    if (!game) {
      errorMsg = `No game found with code “${code}”.`;
      loading = false;
      return;
    }

    if (game.status === 'ended') {
      errorMsg = 'That game has already ended.';
      loading = false;
      return;
    }

    go(`/join?session=${game.id}&code=${code}`);
  }
</script>

<div class="chips-page">
  <p class="chips-back"><a href="/">← back</a></p>
  <h1 class="chips-title">Chips</h1>
  <p class="chips-blurb">
    Poker night without the chips. One phone per player — blinds, bets, and pots keep themselves.
    The cards stay real.
  </p>

  <button class="cbtn cbtn-primary cbtn-block start" onclick={handleCreateGame} disabled={loading}>
    Start a game
  </button>

  <div class="cdivider">or join one</div>

  <div class="join-row">
    <input
      class="cinput code-input"
      bind:value={joinCode}
      onkeydown={(e) => e.key === 'Enter' && handleJoinGame()}
      placeholder="WOLF"
      maxlength={8}
      aria-label="Join code"
      autocapitalize="characters"
      autocomplete="off"
    />
    <button class="cbtn" onclick={handleJoinGame} disabled={loading}>Join</button>
  </div>

  {#if errorMsg}
    <p class="cerror">{errorMsg}</p>
  {/if}

  <a class="cbtn leaderboard-link" href="/chips/leaderboard">Leaderboard →</a>

  {#if $displayName}
    <p class="welcome">Welcome back, {$displayName}.</p>
  {/if}
</div>

<style>
  .start {
    font-size: 1.05rem;
    padding: 0.8rem 1.2rem;
  }

  .join-row {
    display: flex;
    align-items: flex-end;
    gap: 1rem;
  }

  .code-input {
    letter-spacing: 0.35em;
    text-transform: uppercase;
    text-align: center;
    font-size: 1.05rem;
  }
  .code-input::placeholder {
    letter-spacing: 0.35em;
  }

  /* Secondary destination — set apart from the create/join flow, kept quiet
     so "Start a game" stays the one primary action on the page. */
  .leaderboard-link {
    display: inline-block;
    margin-top: 3.5rem;
    text-decoration: none;
  }

  .welcome {
    margin-top: 2rem;
    font-size: 0.85rem;
    color: var(--whisper);
    font-style: italic;
  }
</style>
