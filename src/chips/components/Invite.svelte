<script lang="ts">
  import { onMount } from 'svelte';
  import { go } from '../lib/nav';
  import { initIdentity } from '../lib/stores/identity';
  import { normalizeCode } from '../lib/utils/joinCode';
  import { findGameByCode } from '../lib/services/game';

  // Shareable invite link: /chips/WOLF resolves the join code and drops the
  // visitor straight into the join flow. Unknown or ended codes land on an
  // explanation instead of a silent redirect.
  let { code: rawCode } = $props<{ code: string }>();

  let status = $state<'looking' | 'notFound' | 'ended'>('looking');
  let code = $state('');

  onMount(async () => {
    await initIdentity();
    code = normalizeCode(rawCode);
    const game = code ? await findGameByCode(code) : null;
    if (!game) {
      status = 'notFound';
      return;
    }
    if (game.status === 'ended') {
      status = 'ended';
      return;
    }
    go(`/join?session=${game.id}&code=${game.join_code}`, { replace: true });
  });
</script>

<div class="chips-page">
  {#if status === 'looking'}
    <p class="looking">Looking up game{code ? ` “${code}”` : ''}…</p>
  {:else}
    <p class="chips-back"><a href="/chips">← chips</a></p>
    <h1 class="chips-title">Chips</h1>
    {#if status === 'ended'}
      <p class="chips-blurb">
        The game <span class="chips-code">{code}</span> has already ended.
      </p>
    {:else}
      <p class="chips-blurb">
        No game found with code <span class="chips-code">{code}</span>.
      </p>
    {/if}
    <a class="cbtn home-link" href="/chips">Go to chips</a>
  {/if}
</div>

<style>
  .looking {
    color: var(--faint);
    font-size: 0.95rem;
    margin-top: 4rem;
    text-align: center;
  }

  .home-link {
    display: inline-block;
    text-decoration: none;
  }
</style>
