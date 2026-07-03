<script lang="ts">
  import { onMount } from 'svelte';
  import { go } from '../lib/nav';
  import { initIdentity, displayName, identityId, saveIdentity } from '../lib/stores/identity';
  import { joinSession, getSession } from '../lib/services/game';

  let sessionId = $state('');
  let joinCode = $state('');
  let name = $state('');
  let startingStack = $state<number | null>(null);
  let errorMsg = $state('');
  let loading = $state(false);

  onMount(async () => {
    await initIdentity();
    const params = new URLSearchParams(window.location.search);
    sessionId = params.get('session') ?? '';
    joinCode = params.get('code') ?? '';
    name = $displayName;
    if (sessionId) {
      const session = await getSession(sessionId);
      startingStack = session?.starting_stack ?? null;
    }
  });

  async function handleJoinGame() {
    loading = true;
    errorMsg = '';

    if (!name.trim()) {
      errorMsg = 'Enter your name.';
      loading = false;
      return;
    }

    await saveIdentity(name.trim());

    try {
      await joinSession(sessionId, $identityId, name.trim());
      go(`/table?session=${sessionId}`);
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : 'Failed to join. Try again.';
      loading = false;
    }
  }
</script>

<div class="chips-page">
  <p class="chips-back"><a href="/chips">← chips</a></p>
  <h1 class="chips-title">Join the game</h1>
  <p class="chips-sub"><span class="chips-code">{joinCode}</span></p>

  <div class="cfield">
    <label for="join-name">Your name</label>
    <input id="join-name" bind:value={name} maxlength="40" autocomplete="name" />
  </div>

  <!-- Buy-in is fixed by the host at game setup -->
  {#if startingStack !== null}
    <p class="stack-note">
      You'll sit down with <strong>{startingStack} chips</strong> — the host set the buy-in.
    </p>
  {/if}

  {#if errorMsg}
    <p class="cerror">{errorMsg}</p>
  {/if}

  <button class="cbtn cbtn-primary cbtn-block sit" onclick={handleJoinGame} disabled={loading}>
    {loading ? 'Joining…' : 'Take a seat'}
  </button>
</div>

<style>
  .stack-note {
    font-size: 0.95rem;
    line-height: 1.6;
    color: var(--ink-soft);
    margin: 0 0 2rem;
  }

  .sit {
    font-size: 1.05rem;
    padding: 0.8rem 1.2rem;
    margin-top: 1rem;
  }
</style>
