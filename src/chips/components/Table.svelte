<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fade } from 'svelte/transition';
  import { go, inviteUrl } from '../lib/nav';
  import { initIdentity, identityId } from '../lib/stores/identity';
  import { createTableStore, type TableStore } from '../lib/stores/table.svelte';
  import { netResult, netColor } from '../lib/utils/format';
  import { snapToStep } from '../lib/utils/bet';
  import { renderSVG } from 'uqr';
  import { groupEventsByHand, describeEvent, streetLabel } from '../lib/utils/ledger';
  import type { Player } from '../lib/types';

  let sessionId = $state('');
  let store = $state<TableStore | null>(null);

  let showBetting = $state(false);
  let betAmount = $state(0);
  let betError = $state('');
  let showMenu = $state(false);
  let showRebuy = $state(false);
  let showLedger = $state(false);
  let ledgerScrollEl = $state<HTMLDivElement | null>(null);
  let rebuyAmount = $state(200);
  let showLeaveConfirm = $state(false);
  let showVoidConfirm = $state(false);
  let showResetConfirm = $state(false);
  let blindUnit = $state<'SB' | 'BB'>('SB');
  let betStep = $derived(
    blindUnit === 'SB' ? (store?.session?.small_blind ?? 1) : (store?.session?.big_blind ?? 1)
  );
  let blindsCount = $derived(betStep > 0 ? betAmount / betStep : 0);
  let showRankings = $state(false);
  let showSchedulePanel = $state(false);
  let showQrCode = $state(false);

  // Invite link + QR, built only once the modal opens (window isn't available in SSR).
  const joinUrl = $derived(
    showQrCode && store?.session?.join_code ? inviteUrl(store.session.join_code) : null
  );
  const qrSvg = $derived(joinUrl ? renderSVG(joinUrl) : null);

  // Tapping the invite URL copies it — quicker than reading out a QR to someone
  // sitting next to you. Reverts the "copied" note after a beat.
  let inviteCopied = $state(false);
  async function copyInvite() {
    if (!joinUrl) return;
    try {
      await navigator.clipboard.writeText(joinUrl);
      inviteCopied = true;
      setTimeout(() => (inviteCopied = false), 1500);
    } catch {
      // Clipboard blocked (insecure context / permissions) — leave the URL visible to copy by hand.
    }
  }

  // Copy on a press-and-hold too, not just a tap. Guard the trailing click so a
  // long press doesn't copy twice.
  let inviteHoldTimer: ReturnType<typeof setTimeout> | null = null;
  let inviteHeld = false;
  function startInviteHold() {
    cancelInviteHold();
    inviteHeld = false;
    inviteHoldTimer = setTimeout(() => {
      inviteHeld = true;
      void copyInvite();
    }, 450);
  }
  function cancelInviteHold() {
    if (inviteHoldTimer) {
      clearTimeout(inviteHoldTimer);
      inviteHoldTimer = null;
    }
  }
  function onInviteClick() {
    if (inviteHeld) {
      inviteHeld = false;
      return;
    }
    void copyInvite();
  }

  let focusedPlayerId = $state<string | null>(null);

  // Seat reorder drag state
  let draggingId = $state<string | null>(null);
  let localOrder = $state<Player[]>([]);
  let reorderToast = $state(false);
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let pointerStartPos: { x: number; y: number } | null = null;

  const canReorder = $derived(!!store?.me?.is_host && store?.session?.street === 'preflop');

  // The lone survivor when everyone else has folded mid-hand with chips still in the pot.
  // No showdown UI fires in this case (it needs 2+ players), so the host awards the pot here.
  const foldWin = $derived.by(() => {
    const sess = store?.session;
    if (!sess || sess.street === 'showdown' || !sess.current_actor_id || (sess.pot ?? 0) <= 0) {
      return null;
    }
    const inHand = (store?.players ?? []).filter((p) => p.is_active && !p.folded);
    return inHand.length === 1 ? inHand[0] : null;
  });

  // Keep localOrder in sync with active players (in seat order) when not dragging
  $effect(() => {
    if (!draggingId) {
      localOrder = [...(store?.players ?? []).filter((p) => p.is_active)].sort(
        (a, b) => a.seat_order - b.seat_order
      );
    }
  });

  // Cancel drag if reordering becomes unavailable (e.g. street advances)
  $effect(() => {
    if (!canReorder && draggingId) {
      cancelLongPress();
      draggingId = null;
    }
  });

  // Prevent page scroll while actively dragging
  $effect(() => {
    if (typeof document === 'undefined') return;
    document.body.style.touchAction = draggingId ? 'none' : '';
  });

  // Active players in seat order (drag order while reordering). Drives both the rendered
  // list and the dealer/sb/bb badge math, which are positional and must follow this order.
  const activeBySeat = $derived(
    canReorder
      ? localOrder
      : [...(store?.players ?? []).filter((p) => p.is_active)].sort(
          (a, b) => a.seat_order - b.seat_order
        )
  );

  // Active players in seat order + inactive players appended
  const displayPlayers = $derived([
    ...activeBySeat,
    ...(store?.players ?? []).filter((p) => !p.is_active)
  ]);

  // Players dealt into the current hand — busted players sit out, so the dealer/sb/bb badge
  // positions must be computed without them (blinds skip empty stacks).
  const seatsInHand = $derived(activeBySeat.filter((p) => p.stack > 0 || p.hand_total_bet > 0));

  // SB/BB badge holders, computed once per state change instead of per player row.
  const badgeButtonIdx = $derived(
    seatsInHand.findIndex((p) => p.id === store?.session?.button_player_id)
  );
  const sbBadgeId = $derived(seatsInHand[(badgeButtonIdx + 1) % seatsInHand.length]?.id);
  const bbBadgeId = $derived(seatsInHand[(badgeButtonIdx + 2) % seatsInHand.length]?.id);

  function cancelLongPress() {
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = null;
    pointerStartPos = null;
  }

  function onPlayerPointerDown(playerId: string, e: PointerEvent) {
    if (!canReorder) return;
    pointerStartPos = { x: e.clientX, y: e.clientY };
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      draggingId = playerId;
      focusedPlayerId = null;
      longPressTimer = null;
      pointerStartPos = null;
    }, 500);
  }

  async function commitReorder() {
    const orderToCommit = [...localOrder];
    const wasStarted = !!store?.session?.current_actor_id;
    draggingId = null;
    await store?.reorderSeats(orderToCommit);
    if (wasStarted) {
      reorderToast = true;
      setTimeout(() => (reorderToast = false), 2500);
    }
  }

  // Document-level pointer tracking for drag — set up once after store is ready
  $effect(() => {
    if (!store) return;

    function handleMove(e: PointerEvent) {
      if (pointerStartPos && !draggingId) {
        const dx = e.clientX - pointerStartPos.x;
        const dy = e.clientY - pointerStartPos.y;
        if (Math.sqrt(dx * dx + dy * dy) > 8) cancelLongPress();
        return;
      }
      if (!draggingId) return;

      const under = document.elementFromPoint(e.clientX, e.clientY);
      const cardEl = under?.closest('[data-player-id]') as HTMLElement | null;
      const overId = cardEl?.dataset.playerId;

      if (overId && overId !== draggingId) {
        const next = [...localOrder];
        const from = next.findIndex((p) => p.id === draggingId);
        const to = next.findIndex((p) => p.id === overId);
        if (from !== -1 && to !== -1) {
          const [item] = next.splice(from, 1);
          next.splice(to, 0, item);
          localOrder = next;
        }
      }
    }

    function handleUp() {
      cancelLongPress();
      if (draggingId) void commitReorder();
    }

    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
    document.addEventListener('pointercancel', handleUp);

    return () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
      document.removeEventListener('pointercancel', handleUp);
    };
  });

  const HAND_RANKINGS = [
    { name: 'Royal Flush', desc: 'A K Q J 10 of the same suit' },
    { name: 'Straight Flush', desc: 'Five consecutive cards of the same suit' },
    { name: 'Four of a Kind', desc: 'Four cards of the same rank' },
    { name: 'Full House', desc: 'Three of a kind plus a pair' },
    { name: 'Flush', desc: 'Any five cards of the same suit' },
    { name: 'Straight', desc: 'Five consecutive cards of any suit' },
    { name: 'Three of a Kind', desc: 'Three cards of the same rank' },
    { name: 'Two Pair', desc: 'Two different pairs' },
    { name: 'One Pair', desc: 'Two cards of the same rank' },
    { name: 'High Card', desc: 'Highest single card when no hand is made' }
  ];

  let streetAnnouncement = $state<string | null>(null);
  let prevStreet = $state<string | null>(null);
  let streetTimer: ReturnType<typeof setTimeout> | null = null;
  let showdownReady = $state(false);
  let potAwardIndex = $state(0);

  const STREET_LABELS: Record<string, string> = {
    flop: 'Flop',
    turn: 'Turn',
    river: 'River',
    showdown: 'Showdown'
  };

  $effect(() => {
    const current = store?.session?.street ?? null;
    if (current !== null) {
      if (prevStreet !== null && current !== prevStreet) {
        showdownReady = false;
        potAwardIndex = 0;
        if (STREET_LABELS[current]) {
          streetAnnouncement = STREET_LABELS[current];
          if (streetTimer) clearTimeout(streetTimer);
          streetTimer = setTimeout(() => {
            streetAnnouncement = null;
            if (current === 'showdown') showdownReady = true;
          }, 2500);
        }
      }
      prevStreet = current;
    }
  });

  onMount(async () => {
    await initIdentity();
    const params = new URLSearchParams(window.location.search);
    sessionId = params.get('session') ?? '';
    if (!sessionId) {
      go('/');
      return;
    }

    store = createTableStore(sessionId, $identityId);
    await store.init();
    betAmount = store.session?.big_blind ?? 0;
  });

  onDestroy(() => store?.destroy());

  $effect(() => {
    if (store?.ended) go(`/cashout?session=${sessionId}`);
  });

  $effect(() => {
    if (store && !store.loading && store.me && !store.me.is_active) {
      go(`/cashout?session=${sessionId}`);
    }
  });

  // Pot-fraction presets snap to the current blind step so bets stay in clean units.
  function potBet(fraction: number) {
    const raw = Math.round((store?.session?.pot ?? 0) * fraction);
    return snapToStep(raw, betStep, store?.me?.stack ?? 0);
  }

  // Pending out-of-turn action awaiting confirmation (null = none).
  let pendingOutOfTurn = $state<{ action: 'check' | 'call' | 'raise'; amount: number } | null>(
    null
  );

  // What each player ahead of me will be marked as if I confirm the pending action.
  const ootResolutions = $derived.by(() => {
    const before = store?.playersBeforeMe ?? [];
    const currentBet = store?.session?.current_bet ?? 0;
    return before.map((p) => ({
      player: p,
      action: p.current_round_bet < currentBet ? 'Fold' : 'Check'
    }));
  });

  async function runPlaceBet(outOfTurn: boolean) {
    betError = '';
    const err = (await store?.placeBet(betAmount, outOfTurn)) ?? '';
    if (err) {
      betError = err;
      return;
    }
    showBetting = false;
    betAmount = store?.session?.big_blind ?? 0;
  }

  function handlePlaceBet() {
    if (store?.isMyTurn) {
      void runPlaceBet(false);
    } else {
      pendingOutOfTurn = { action: 'raise', amount: betAmount };
    }
  }

  // Check / Call tapped: act immediately if it's my turn, otherwise confirm out of turn.
  function handleCheck() {
    if (store?.isMyTurn) void store.passTurn();
    else pendingOutOfTurn = { action: 'check', amount: 0 };
  }

  // Folding when checking is free deserves a gentle intervention.
  let showFoldWarning = $state(false);

  function handleFold() {
    const owed = (store?.session?.current_bet ?? 0) - (store?.me?.current_round_bet ?? 0);
    if (owed <= 0) {
      showFoldWarning = true;
      return;
    }
    void store?.fold();
  }

  function handleCall() {
    if (store?.isMyTurn) void store.call();
    else pendingOutOfTurn = { action: 'call', amount: 0 };
  }

  async function confirmOutOfTurn() {
    const pending = pendingOutOfTurn;
    if (!pending || !store) return;
    pendingOutOfTurn = null;
    if (pending.action === 'check') await store.passTurn(true);
    else if (pending.action === 'call') await store.call(true);
    else await runPlaceBet(true);
  }

  async function handleDoRebuy() {
    await store?.doRebuy(rebuyAmount);
    showRebuy = false;
    showMenu = false;
  }

  function openMenu() {
    showBetting = false;
    showMenu = true;
  }

  function openLedger() {
    showMenu = false;
    showLedger = true;
  }

  // Auto-scroll the ledger to the newest entry (bottom) when open and as events arrive.
  $effect(() => {
    const count = store?.events.length ?? 0;
    if (showLedger && ledgerScrollEl && count >= 0) {
      ledgerScrollEl.scrollTop = ledgerScrollEl.scrollHeight;
    }
  });

  function closeMenu() {
    showMenu = false;
    showRebuy = false;
    showLeaveConfirm = false;
    showVoidConfirm = false;
    showResetConfirm = false;
  }
</script>

{#if !store || store.loading}
  <div class="chips-page">
    <p class="loading">Setting the table…</p>
  </div>
{:else}
  {@const s = store!}
  {@const callAmount = (s.session?.current_bet ?? 0) - (s.me?.current_round_bet ?? 0)}
  <div class="chips-app">
    <!-- Street announcement popup -->
    {#if streetAnnouncement}
      {@const annBoard =
        streetAnnouncement === 'Flop'
          ? { count: 3, newFrom: 0 }
          : streetAnnouncement === 'Turn'
            ? { count: 4, newFrom: 3 }
            : streetAnnouncement === 'River'
              ? { count: 5, newFrom: 4 }
              : null}
      <div transition:fade={{ duration: 300 }} class="street-pop" aria-live="polite">
        <div class="street-pop-card">
          {#if annBoard}
            <div class="board-preview" aria-hidden="true">
              {#each Array.from({ length: annBoard.count }) as _, i (i)}
                <span class="card-slot" class:dealt={i >= annBoard.newFrom}></span>
              {/each}
            </div>
          {/if}
          <span class="street-pop-text">{streetAnnouncement}</span>
        </div>
      </div>
    {/if}

    <!-- Out-of-turn confirmation -->
    {#if pendingOutOfTurn}
      <button
        class="cmodal-backdrop"
        onclick={() => (pendingOutOfTurn = null)}
        aria-label="Cancel"
      ></button>
      <div class="cmodal">
        <p class="cmodal-title">Acting out of turn</p>
        {#if ootResolutions.length}
          <p>Confirm the players before you have already acted:</p>
          <ul class="oot-list">
            {#each ootResolutions as r (r.player.id)}
              <li class="oot-row">
                <span>{r.player.display_name}</span>
                <span class="pill" class:pill-fold={r.action === 'Fold'}
                  >{r.action.toLowerCase()}</span
                >
              </li>
            {/each}
          </ul>
        {:else}
          <p>No players are waiting ahead of you.</p>
        {/if}
        <p>
          Then you'll
          {#if pendingOutOfTurn.action === 'check'}
            <strong>check</strong>.
          {:else if pendingOutOfTurn.action === 'call'}
            <strong>call {(s.session?.current_bet ?? 0) - (s.me?.current_round_bet ?? 0)}</strong>.
          {:else}
            <strong>raise to {pendingOutOfTurn.amount}</strong>.
          {/if}
        </p>
        <div class="btn-row">
          <button class="cbtn" onclick={() => (pendingOutOfTurn = null)}>Cancel</button>
          <button class="cbtn cbtn-primary" onclick={confirmOutOfTurn}>Confirm</button>
        </div>
      </div>
    {/if}

    <!-- Zero-pressure fold warning -->
    {#if showFoldWarning}
      <button
        class="cmodal-backdrop"
        onclick={() => (showFoldWarning = false)}
        aria-label="Cancel"
      ></button>
      <div class="cmodal">
        <p class="cmodal-title">Folding under zero pressure?</p>
        <p>
          Nobody has bet a thing — you can check and see the next card for <em>free</em>. Folding
          now is surrendering to an army that hasn't shown up.
        </p>
        <div class="btn-row">
          <button
            class="cbtn cbtn-primary"
            onclick={() => {
              showFoldWarning = false;
              handleCheck();
            }}
          >
            Check
          </button>
          <button
            class="cbtn cbtn-danger"
            onclick={() => {
              showFoldWarning = false;
              void s.fold();
            }}
          >
            Fold anyway
          </button>
        </div>
      </div>
    {/if}

    <!-- Join QR code modal -->
    {#if showQrCode}
      <button
        class="cmodal-backdrop"
        onclick={() => (showQrCode = false)}
        aria-label="Close QR code"
      ></button>
      <div class="cmodal qr-modal">
        <p class="chips-code qr-code-label">{s.session?.join_code}</p>
        {#if qrSvg}
          <div class="qr-box">
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html qrSvg}
          </div>
        {/if}
        {#if joinUrl}
          <button
            class="qr-url"
            onclick={onInviteClick}
            onpointerdown={startInviteHold}
            onpointerup={cancelInviteHold}
            onpointerleave={cancelInviteHold}
            oncontextmenu={(e) => e.preventDefault()}
            aria-label="Copy invite link"
          >
            {inviteCopied ? 'Copied to clipboard' : joinUrl}
          </button>
        {/if}
        <button class="cbtn cbtn-block" onclick={() => (showQrCode = false)}>Close</button>
      </div>
    {/if}

    <!-- Hand rankings modal -->
    {#if showRankings}
      <button
        class="cmodal-backdrop"
        onclick={() => (showRankings = false)}
        aria-label="Close rankings"
      ></button>
      <div class="cmodal">
        <div class="modal-head">
          <p class="cmodal-title">Hand rankings</p>
          <button class="cclose" onclick={() => (showRankings = false)} aria-label="Close"
            >&times;</button
          >
        </div>
        <ol class="rankings">
          {#each HAND_RANKINGS as hand (hand.name)}
            <li class="ranking">
              <span class="ranking-name">{hand.name}</span>
              <span class="ranking-desc">{hand.desc}</span>
            </li>
          {/each}
        </ol>
      </div>
    {/if}

    <!-- Side menu -->
    {#if showMenu}
      <button class="cmodal-backdrop" onclick={closeMenu} aria-label="Close menu"></button>

      <div class="cdrawer">
        <div class="cdrawer-head">
          <p class="cdrawer-title">Menu</p>
          <button class="cclose" onclick={closeMenu} aria-label="Close">&times;</button>
        </div>

        <div class="menu-body">
          <!-- Activity / ledger -->
          <button class="cbtn cbtn-block" onclick={openLedger}>Activity</button>

          <!-- Leaderboard — opens in a new tab so the live table isn't torn down. -->
          <a
            class="cbtn cbtn-block menu-link"
            href="/chips/leaderboard"
            target="_blank"
            rel="noopener"
          >
            Leaderboard
          </a>

          <!-- Rebuy -->
          {#if !showRebuy}
            <button
              class="cbtn cbtn-block"
              onclick={() => {
                showLeaveConfirm = false;
                showRebuy = true;
              }}
            >
              Rebuy
            </button>
          {:else}
            <div class="menu-sub">
              <p class="clabel">Rebuy amount</p>
              <div class="choices">
                {#each [100, 200, 500, 1000] as amount (amount)}
                  <button
                    class="cchoice"
                    class:active={rebuyAmount === amount}
                    onclick={() => (rebuyAmount = amount)}
                  >
                    {amount}
                  </button>
                {/each}
              </div>
              <button class="cbtn cbtn-primary cbtn-block" onclick={handleDoRebuy}>
                Rebuy {rebuyAmount} chips
              </button>
              <button class="cbtn cbtn-small cbtn-block" onclick={() => (showRebuy = false)}
                >Cancel</button
              >
            </div>
          {/if}

          <!-- Leave -->
          {#if !showLeaveConfirm}
            <button
              class="cbtn cbtn-block"
              onclick={() => {
                showRebuy = false;
                showLeaveConfirm = true;
              }}
            >
              Leave table
            </button>
          {:else}
            <div class="menu-sub">
              <p class="menu-note">Leave the table? Your current stack will be recorded.</p>
              <button
                class="cbtn cbtn-danger cbtn-block"
                onclick={async () => {
                  await s.leaveTable();
                  go(`/cashout?session=${sessionId}`);
                }}
              >
                Confirm leave
              </button>
              <button class="cbtn cbtn-small cbtn-block" onclick={() => (showLeaveConfirm = false)}
                >Cancel</button
              >
            </div>
          {/if}

          {#if s.me?.is_host}
            <div class="host-controls">
              <p class="host-label">Host controls</p>
              {#if (s.session?.pot ?? 0) > 0}
                {#if !showVoidConfirm}
                  <button
                    class="cbtn cbtn-block"
                    onclick={() => {
                      showRebuy = false;
                      showLeaveConfirm = false;
                      showVoidConfirm = true;
                    }}
                  >
                    Next hand
                  </button>
                {:else}
                  <div class="menu-sub">
                    <p class="menu-note">
                      There are still {s.session?.pot} chips in the pot that no one claimed.
                      Starting the next hand returns each player's bets and deals again.
                    </p>
                    <button
                      class="cbtn cbtn-primary cbtn-block"
                      onclick={async () => {
                        await s.voidHand();
                        potAwardIndex = 0;
                        closeMenu();
                      }}
                    >
                      Return bets &amp; deal
                    </button>
                    <button
                      class="cbtn cbtn-small cbtn-block"
                      onclick={() => (showVoidConfirm = false)}>Cancel</button
                    >
                  </div>
                {/if}
              {:else}
                <button
                  class="cbtn cbtn-block"
                  onclick={() => {
                    s.endHand();
                    potAwardIndex = 0;
                    closeMenu();
                  }}
                >
                  Next hand
                </button>
              {/if}
              {#if s.session?.current_actor_id}
                {#if !showResetConfirm}
                  <button
                    class="cbtn cbtn-block"
                    onclick={() => {
                      showRebuy = false;
                      showLeaveConfirm = false;
                      showVoidConfirm = false;
                      showResetConfirm = true;
                    }}
                  >
                    Reset hand
                  </button>
                {:else}
                  <div class="menu-sub">
                    <p class="menu-note">
                      Misdeal? Every player gets their bets back and this hand is re-dealt with the
                      same dealer.
                    </p>
                    <button
                      class="cbtn cbtn-primary cbtn-block"
                      onclick={async () => {
                        await s.resetHand();
                        potAwardIndex = 0;
                        closeMenu();
                      }}
                    >
                      Return bets &amp; re-deal
                    </button>
                    <button
                      class="cbtn cbtn-small cbtn-block"
                      onclick={() => (showResetConfirm = false)}>Cancel</button
                    >
                  </div>
                {/if}
              {/if}
              <button
                class="cbtn cbtn-danger cbtn-block"
                onclick={() => {
                  s.endSession();
                  closeMenu();
                }}
              >
                End session
              </button>
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Activity ledger (full-screen sheet) -->
    {#if showLedger}
      {@const groups = groupEventsByHand(s.events)}
      <div class="csheet">
        <div class="sheet-head">
          <p class="cdrawer-title">Activity</p>
          <button class="cclose" onclick={() => (showLedger = false)} aria-label="Close activity"
            >&times;</button
          >
        </div>
        <div bind:this={ledgerScrollEl} class="ledger-scroll">
          {#if groups.length === 0}
            <p class="cnote ledger-empty">No activity yet.</p>
          {:else}
            {#each groups as group (group.hand)}
              <div class="ledger-hand">
                <p class="ledger-hand-label">
                  {group.hand === 0 ? 'Lobby' : `Hand ${group.hand}`}
                </p>
                {#each group.events as event (event.id)}
                  {#if event.type === 'street'}
                    <div class="ledger-street">
                      <span class="ledger-street-label">{streetLabel(event.street)}</span>
                    </div>
                  {:else}
                    {@const name =
                      s.players.find((p) => p.id === event.player_id)?.display_name ?? 'Someone'}
                    <p class="ledger-line">{describeEvent(event, name)}</p>
                  {/if}
                {/each}
              </div>
            {/each}
          {/if}
        </div>
      </div>
    {/if}

    <!-- Blind schedule (bottom sheet) -->
    {#if showSchedulePanel && s.hasBlindSchedule}
      <button
        class="cmodal-backdrop"
        onclick={() => (showSchedulePanel = false)}
        aria-label="Close schedule"
      ></button>
      <div class="bottom-sheet">
        <div class="bottom-sheet-head">
          <p class="cdrawer-title">Blind schedule</p>
          {#if s.blindTimeDisplay}
            <p class="clabel">{s.blindTimeDisplay} left</p>
          {/if}
        </div>
        <div class="sched-list">
          {#each s.session?.blind_schedule ?? [] as level, i (level.level)}
            {@const isCurrent = i === (s.session?.blind_level ?? 0)}
            <div class="sched-row" class:current={isCurrent}>
              <span class="sched-level">level {level.level}</span>
              <span class="sched-blinds">{level.small_blind}/{level.big_blind}</span>
              {#if level.duration_minutes > 0}
                <span class="sched-mins">{level.duration_minutes}m</span>
              {:else}
                <span class="sched-mins"></span>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Cash escalation prompt (host only) -->
    {#if s.escalationSuggestion && s.me?.is_host}
      <div class="escalation">
        <div class="escalation-text">
          <p class="escalation-title">Player left</p>
          <p class="clabel">
            Raise blinds to {s.escalationSuggestion.small_blind}/{s.escalationSuggestion.big_blind}?
          </p>
        </div>
        <div class="escalation-btns">
          <button class="cbtn cbtn-small cbtn-primary" onclick={() => s.advanceBlindLevel()}
            >Apply</button
          >
          <button class="cbtn cbtn-small" onclick={() => s.dismissEscalation()}>Dismiss</button>
        </div>
      </div>
    {/if}

    <!-- Header (tap the left block for the join QR code) -->
    <header class="table-head">
      <div
        role="button"
        tabindex="0"
        aria-label="Show join QR code"
        onclick={() => (showQrCode = true)}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') showQrCode = true;
        }}
        class="head-left"
      >
        <p class="head-code">
          <span class="chips-code">{s.session?.join_code}</span>
          <span class="pill">QR</span>
        </p>
        {#if s.hasBlindSchedule}
          <button
            class="head-blinds head-blinds-btn"
            onclick={(e) => {
              e.stopPropagation();
              showSchedulePanel = true;
            }}
          >
            blinds {s.session?.small_blind}/{s.session?.big_blind} ›
          </button>
        {:else}
          <p class="head-blinds">blinds {s.session?.small_blind}/{s.session?.big_blind}</p>
        {/if}
        {#if s.session?.current_actor_id}
          <p class="head-street">{s.session.street}</p>
        {/if}
      </div>
      <div class="head-right">
        {#if (s.session?.current_bet ?? 0) > 0}
          <div class="head-stat">
            <p class="head-stat-label">bet</p>
            <p class="head-stat-num">{s.session?.current_bet}</p>
          </div>
        {/if}
        <div class="head-stat">
          <p class="head-stat-label">pot</p>
          <p class="head-stat-num">{s.session?.pot ?? 0}</p>
        </div>
        <button class="cstep" onclick={() => (showRankings = true)} aria-label="Hand rankings"
          >?</button
        >
        {#if s.me}
          <button class="menu-btn" onclick={openMenu} aria-label="Open menu">menu</button>
        {/if}
      </div>
    </header>

    <!-- Turn indicator banner (hidden while the table waits on the next street) -->
    {#if s.streetComplete}
      <div class="banner banner-done"><p>betting complete</p></div>
    {:else if s.currentActor}
      {#if s.currentActor.identity_id === $identityId}
        <div class="banner banner-turn"><p>your turn</p></div>
      {:else}
        <div class="banner banner-wait">
          <p>waiting for <strong>{s.currentActor.display_name}</strong></p>
        </div>
      {/if}
    {/if}

    <!-- Kick focus backdrop -->
    {#if focusedPlayerId}
      <button class="focus-backdrop" onclick={() => (focusedPlayerId = null)} aria-label="Dismiss"
      ></button>
    {/if}

    <!-- Reorder toast -->
    {#if reorderToast}
      <div transition:fade={{ duration: 300 }} class="banner banner-wait">
        <p>Seats rearranged — hand reset to blinds</p>
      </div>
    {/if}

    <!-- Player list -->
    <div class="players">
      {#if canReorder}
        <p class="reorder-hint">hold a player to reorder seats</p>
      {/if}
      {#each displayPlayers as player (player.id)}
        {@const isButton = player.id === s.session?.button_player_id}
        {@const isCurrentActor = player.id === s.session?.current_actor_id}
        {@const isSB = player.id === sbBadgeId}
        {@const isBB = player.id === bbBadgeId}
        {@const isFocused = focusedPlayerId === player.id}
        {@const isBusted = player.is_active && player.stack === 0 && player.hand_total_bet === 0}
        {@const isFocusable = s.me?.is_host && player.is_active}
        {@const isKickable = isFocusable && player.identity_id !== $identityId}
        {@const canMakeDealer =
          isFocusable &&
          !isBusted &&
          player.id !== s.session?.button_player_id &&
          (!s.session?.current_actor_id || s.session?.street === 'preflop')}
        {@const isDragging = draggingId === player.id}

        <div
          data-player-id={player.id}
          class="player-row"
          class:inactive={!player.is_active}
          class:folded={player.is_active && player.folded}
          class:actor={isCurrentActor}
          class:focused={isFocused}
          class:dragging={isDragging}
          class:reorderable={canReorder && player.is_active && !isDragging}
          role={isFocusable ? 'button' : undefined}
          onclick={isFocusable ? () => (focusedPlayerId = isFocused ? null : player.id) : undefined}
          onkeydown={isFocusable
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ')
                  focusedPlayerId = isFocused ? null : player.id;
              }
            : undefined}
          onpointerdown={canReorder && player.is_active
            ? (e) => onPlayerPointerDown(player.id, e)
            : undefined}
        >
          <div class="player-main">
            <div class="player-name-line">
              {#if isCurrentActor}<span class="turn-mark" aria-hidden="true">→</span>{/if}
              <span class="player-name" class:is-actor={isCurrentActor}>{player.display_name}</span>
              {#if !player.is_active}<span class="pill">out</span
                >{:else if isBusted}<span class="pill">busted</span
                >{:else if player.folded}<span class="pill">folded</span>{/if}
              {#if isButton && !player.folded}<span class="pill pill-dark">dealer</span>{/if}
              {#if isSB && !player.folded}<span class="pill">SB</span>{/if}
              {#if isBB && !player.folded}<span class="pill">BB</span>{/if}
              {#if player.is_host}<span class="pill-plain pill">host</span>{/if}
              {#if player.identity_id === $identityId}<span class="pill-plain pill">you</span>{/if}
            </div>
            <p class="player-net {netColor(player.stack, player.total_buyin)}">
              {netResult(player.stack, player.total_buyin)} net
            </p>
          </div>
          <div class="player-stack">
            {#if isBusted}
              <p class="stack-busted">busted</p>
            {:else if player.stack === 0 && !player.folded && player.is_active}
              <p class="stack-allin">
                all in{player.current_round_bet > 0 ? ` · ${player.current_round_bet}` : ''}
              </p>
            {:else}
              <p class="stack-num">{player.stack}</p>
              {#if player.current_round_bet > 0}
                <p class="stack-in">in {player.current_round_bet}</p>
              {/if}
            {/if}
          </div>
          {#if isFocused}
            <div class="player-actions">
              {#if canMakeDealer}
                <button
                  class="cbtn cbtn-small"
                  onclick={(e) => {
                    e.stopPropagation();
                    s.setDealer(player.id);
                    focusedPlayerId = null;
                  }}
                >
                  Make dealer
                </button>
              {/if}
              {#if isKickable}
                <button
                  class="cbtn cbtn-small cbtn-danger"
                  onclick={(e) => {
                    e.stopPropagation();
                    s.kickPlayer(player.id);
                    focusedPlayerId = null;
                  }}
                >
                  Kick
                </button>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <!-- Action bar -->
    {#if s.me}
      <div class="action-bar">
        <!-- Primary actions: Fold / Check+Call / Raise -->
        {#if !s.me.folded && s.me.stack > 0 && s.session?.street !== 'showdown' && !foldWin && !s.streetComplete}
          <div class="btn-row">
            <button class="act act-fold" onclick={handleFold} disabled={s.actionPending}>
              Fold
            </button>
            {#if callAmount > 0}
              <button class="act act-check" onclick={handleCall} disabled={s.actionPending}>
                Call {callAmount}
              </button>
            {:else}
              <button class="act act-check" onclick={handleCheck} disabled={s.actionPending}
                >Check</button
              >
            {/if}
            {#if s.canRaise}
              <button
                class="act act-raise"
                onclick={() => {
                  showBetting = !showBetting;
                }}
              >
                {showBetting ? 'Close bet' : 'Raise'}
              </button>
            {/if}
          </div>
        {/if}

        <!-- Betting round done: host or dealer confirms once the cards are dealt IRL -->
        {#if s.streetComplete}
          <!-- Board preview: card slots for the street about to come. The flop
               deals three fresh cards; the turn and river add one, so only the
               new (rightmost) slot is highlighted then. -->
          {@const street = s.session?.street}
          {@const board =
            street === 'preflop'
              ? { count: 3, newFrom: 0 }
              : street === 'flop'
                ? { count: 4, newFrom: 3 }
                : street === 'turn'
                  ? { count: 5, newFrom: 4 }
                  : null}
          {#if board}
            <div class="board-preview" aria-hidden="true">
              {#each Array.from({ length: board.count }) as _, i (i)}
                <span class="card-slot" class:dealt={i >= board.newFrom}></span>
              {/each}
            </div>
          {/if}
          {#if s.canConfirmNextStreet}
            <button
              class="cbtn cbtn-primary cbtn-block"
              onclick={() => s.confirmNextStreet()}
              disabled={s.actionPending}
            >
              {s.nextStreetAction}
            </button>
          {:else}
            <p class="cnote center">Waiting for the host or dealer to deal the next street…</p>
          {/if}
        {/if}

        <!-- Fold win: everyone else folded, lone survivor takes the pot -->
        {#if foldWin}
          {#if s.me?.is_host}
            <div class="award">
              <p class="award-label">everyone folded</p>
              <p class="award-amount">{s.session?.pot} chips</p>
              <button
                class="cbtn cbtn-primary cbtn-block"
                onclick={async () => {
                  const winnerId = foldWin.id;
                  await s.awardPot(winnerId, s.session?.pot ?? 0);
                  await s.endHand();
                  potAwardIndex = 0;
                }}
                disabled={s.actionPending}
              >
                {foldWin.display_name} wins — deal next hand
              </button>
            </div>
          {:else}
            <p class="cnote center">Waiting for host…</p>
          {/if}
        {/if}

        <!-- Showdown: winner selection -->
        {#if s.session?.street === 'showdown' && showdownReady}
          {#if s.me?.is_host}
            {@const currentPot = s.pots[potAwardIndex]}
            {#if currentPot}
              <div class="award">
                <div class="award-head">
                  <p class="award-label">
                    {s.pots.length > 1
                      ? potAwardIndex === 0
                        ? 'main pot'
                        : `side pot ${potAwardIndex}`
                      : 'pot'}
                  </p>
                  {#if s.pots.length > 1}
                    <p class="clabel">{potAwardIndex + 1} of {s.pots.length}</p>
                  {/if}
                </div>
                <p class="award-amount">{currentPot.amount} chips</p>
                <p class="clabel">tap the winner to award</p>
                <div class="btn-row wrap">
                  {#each s.players.filter((p) => currentPot.eligibleIds.includes(p.id)) as player (player.id)}
                    <button
                      class="cbtn winner-btn"
                      onclick={() => {
                        s.awardPot(player.id, currentPot.amount);
                        potAwardIndex++;
                      }}
                      disabled={s.actionPending}
                    >
                      {player.display_name}
                    </button>
                  {/each}
                </div>
              </div>
            {:else}
              <!-- All pots awarded — host starts next hand -->
              <button
                class="cbtn cbtn-primary cbtn-block"
                onclick={() => {
                  s.endHand();
                  potAwardIndex = 0;
                  closeMenu();
                }}
                disabled={s.actionPending}
              >
                Next hand
              </button>
            {/if}
          {:else}
            <p class="cnote center">Waiting for host…</p>
          {/if}
        {/if}

        <!-- Situational buttons (start game / claim host) -->
        {#if (s.me?.is_host && !s.session?.current_actor_id && s.session?.street !== 'showdown') || s.staleHost}
          <div class="btn-row">
            {#if s.me?.is_host && !s.session?.current_actor_id && s.session?.street !== 'showdown'}
              <button class="cbtn cbtn-primary" onclick={() => s.startGame()}>Start game</button>
            {/if}

            {#if s.staleHost}
              <button class="cbtn" onclick={() => s.claimHost()}>Claim host</button>
            {/if}
          </div>
        {/if}

        <!-- Raise / Bet panel -->
        {#if showBetting && s.canRaise && !s.streetComplete}
          <div class="bet-panel">
            <div class="btn-row wrap">
              {#each [[0.5, '½ pot'], [0.75, '¾ pot'], [1, '1× pot'], [2, '2× pot']] as [frac, label] (frac)}
                <button class="cchoice grow" onclick={() => (betAmount = potBet(frac as number))}>
                  {label}
                </button>
              {/each}
              <button class="cchoice grow allin" onclick={() => (betAmount = s.me?.stack ?? 0)}>
                all-in
              </button>
            </div>

            <div class="bet-slider">
              <button
                class="cstep"
                onclick={() => {
                  betAmount = Math.max(0, betAmount - betStep);
                }}
                aria-label="Decrease bet"
              >
                −
              </button>
              <input
                type="range"
                min="0"
                max={s.me?.stack ?? 0}
                step={betStep}
                bind:value={betAmount}
              />
              <button
                class="cstep"
                onclick={() => {
                  betAmount = Math.min(s.me?.stack ?? 0, betAmount + betStep);
                }}
                aria-label="Increase bet"
              >
                +
              </button>
              <button
                class="cbtn cbtn-small unit-toggle"
                onclick={() => {
                  const next = blindUnit === 'SB' ? 'BB' : 'SB';
                  const nextStep =
                    next === 'SB'
                      ? (store?.session?.small_blind ?? 1)
                      : (store?.session?.big_blind ?? 1);
                  betAmount = snapToStep(betAmount, nextStep, s.me?.stack ?? 0);
                  blindUnit = next;
                }}
                aria-label="Toggle blind unit"
              >
                {blindsCount % 1 === 0 ? blindsCount : blindsCount.toFixed(1)}
                {blindUnit}
              </button>
            </div>

            {#if betError}
              <p class="cerror">{betError}</p>
            {/if}

            <button
              class="cbtn cbtn-primary cbtn-block"
              onclick={handlePlaceBet}
              disabled={s.actionPending}
            >
              {s.actionPending ? 'Sending…' : `Confirm raise — ${betAmount} chips`}
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .loading {
    color: var(--faint);
    font-size: 0.95rem;
    text-align: center;
    margin-top: 4rem;
  }

  /* --- Street announcement --- */
  .street-pop {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    z-index: 60;
  }
  .street-pop-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    color: var(--ink);
    background: var(--paper);
    border: 1px solid var(--rule);
    border-radius: 4px;
    box-shadow: 0 12px 40px rgba(42, 42, 42, 0.18);
    padding: 1.5rem 2.75rem;
  }
  .street-pop-text {
    font-family: var(--serif-display);
    font-style: italic;
    font-size: 2rem;
  }

  /* --- Header --- */
  .table-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 1rem 1.25rem 0.85rem;
    border-bottom: 1px solid var(--hairline);
  }

  .head-left {
    cursor: pointer;
    user-select: none;
    min-width: 0;
  }
  .head-code {
    margin: 0 0 0.2rem;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .head-blinds {
    font-size: 0.8rem;
    color: var(--faint);
    margin: 0;
  }
  .head-blinds-btn {
    font-family: inherit;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-align: left;
  }
  .head-street {
    font-size: 0.8rem;
    font-style: italic;
    color: var(--muted);
    margin: 0.1rem 0 0;
  }

  .head-right {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-shrink: 0;
  }
  .head-stat { text-align: right; }
  .head-stat-label {
    font-size: 0.7rem;
    color: var(--whisper);
    margin: 0;
  }
  .head-stat-num {
    font-size: 1.25rem;
    font-weight: 700;
    margin: 0;
    line-height: 1.2;
  }
  .menu-btn {
    font-family: inherit;
    font-size: 0.9rem;
    background: none;
    border: none;
    padding: 0.25rem 0;
    color: var(--faint);
    cursor: pointer;
    transition: color 1s ease;
  }

  /* --- Banners --- */
  .banner {
    margin: 0.75rem 1.25rem 0;
    text-align: center;
  }
  .banner p {
    margin: 0;
    font-size: 0.9rem;
  }
  .banner-turn {
    background: var(--ink);
    color: var(--paper);
    border-radius: 2rem;
    padding: 0.45rem 1rem;
  }
  .banner-turn p {
    font-weight: 700;
    letter-spacing: 0.08em;
  }
  .banner-wait { color: var(--faint); }
  .banner-done {
    color: var(--muted);
    font-style: italic;
    border-top: 1px solid var(--hairline);
    border-bottom: 1px solid var(--hairline);
    padding: 0.4rem 0;
  }

  /* --- Player list --- */
  .players {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 1.25rem 1rem;
  }

  .reorder-hint {
    font-size: 0.8rem;
    color: var(--whisper);
    text-align: center;
    font-style: italic;
    margin: 0.5rem 0;
  }

  .player-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.8rem 0;
    border-bottom: 1px solid var(--hairline);
    user-select: none;
    -webkit-user-select: none;
    transition: opacity 0.2s ease, transform 0.2s ease;
  }
  .player-row.inactive { opacity: 0.35; }
  .player-row.folded { opacity: 0.45; }
  .player-row.focused { position: relative; z-index: 20; }
  .player-row.dragging {
    transform: scale(1.03);
    opacity: 0.5;
    pointer-events: none;
    position: relative;
    z-index: 30;
  }
  .player-row.reorderable { touch-action: none; }
  .player-row[role='button'] { cursor: pointer; }

  .player-main { min-width: 0; }
  .player-name-line {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .turn-mark { color: var(--ink); }
  .player-name { font-size: 1.05rem; }
  .player-name.is-actor { font-weight: 700; }

  .player-net {
    font-size: 0.8rem;
    margin: 0.15rem 0 0;
  }

  .player-stack {
    text-align: right;
    flex-shrink: 0;
  }
  .stack-num {
    font-size: 1.25rem;
    font-weight: 700;
    margin: 0;
    line-height: 1.2;
  }
  .stack-in {
    font-size: 0.8rem;
    color: var(--faint);
    margin: 0;
  }
  .stack-allin {
    font-size: 1rem;
    color: var(--down);
    font-style: italic;
    margin: 0;
  }
  .stack-busted {
    font-size: 1rem;
    color: var(--whisper);
    font-style: italic;
    margin: 0;
  }

  .player-actions {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .focus-backdrop {
    position: fixed;
    inset: 0;
    z-index: 10;
    background: none;
    border: none;
    cursor: default;
  }

  /* --- Action bar --- */
  .action-bar {
    border-top: 1px solid var(--hairline);
    padding: 1rem 1.25rem calc(1rem + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    background: var(--paper);
  }

  /* Board preview — card-shaped slots shown above the "deal" action. Grey fill
     marks the card(s) about to hit the felt; outlines are cards already out. */
  .board-preview {
    display: flex;
    justify-content: center;
    gap: 0.4rem;
    margin-bottom: 0.15rem;
  }
  .card-slot {
    width: 1.6rem;
    height: 2.2rem;
    border: 1px solid var(--rule);
    border-radius: 3px;
  }
  .card-slot.dealt {
    background: var(--rule);
  }

  .btn-row {
    display: flex;
    gap: 0.5rem;
  }
  .btn-row > :global(.cbtn) { flex: 1; }
  .btn-row.wrap { flex-wrap: wrap; }

  /* Primary in-hand actions — solid, muted fills, no borders, so the table
     reads like a game rather than a page. Colour carries the meaning:
     fold in the ledger red, check/call in neutral grey, raise in the green. */
  .act {
    flex: 1;
    font-family: inherit;
    font-size: 0.95rem;
    border: none;
    border-radius: 2rem;
    padding: 0.6rem 1.2rem;
    cursor: pointer;
    color: var(--paper);
    transition: opacity 0.15s ease;
  }
  .act:disabled { opacity: 0.45; cursor: default; }
  .act-fold { background: var(--down); }
  .act-check { background: var(--muted); }
  .act-raise { background: var(--up); }
  .grow { flex: 1; }
  .center { text-align: center; }

  .award {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .award-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .award-label {
    font-size: 0.8rem;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--faint);
    margin: 0;
  }
  .award-amount {
    font-family: var(--serif-display);
    font-size: 1.9rem;
    font-weight: 700;
    margin: 0;
  }
  .winner-btn {
    flex: 1;
    min-width: 6rem;
  }

  .bet-panel {
    border-top: 1px solid var(--hairline);
    padding-top: 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }
  .allin { color: var(--down); }

  .bet-slider {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .bet-slider input[type='range'] { flex: 1; min-width: 0; }
  .unit-toggle { white-space: nowrap; }

  /* --- Modals --- */
  .modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .oot-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
  }
  .oot-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--hairline);
    font-size: 0.95rem;
  }
  .pill-fold { color: var(--down); border-color: #d9c1ba; }

  .qr-modal { align-items: center; text-align: center; }
  .qr-code-label { font-size: 1.1rem; color: var(--ink); }
  .qr-box {
    background: #fff;
    border: 1px solid var(--hairline);
    border-radius: 4px;
    padding: 0.75rem;
    width: 100%;
    max-width: 15rem;
  }
  .qr-box :global(svg) {
    width: 100%;
    height: auto;
    display: block;
  }
  .qr-url {
    font-family: inherit;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font-size: 0.75rem;
    color: var(--faint);
    word-break: break-all;
    text-align: center;
    transition: color 1s ease;
    /* Tap or press-and-hold copies; suppress the text-selection callout so a
       hold reads as a deliberate copy, not a drag-select. */
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  @media (hover: hover) and (pointer: fine) {
    .qr-url:hover { color: var(--ink); transition: color 0.1s ease; }
  }

  .rankings {
    list-style: none;
    padding: 0;
    margin: 0;
    counter-reset: rank;
    overflow-y: auto;
  }
  .ranking {
    counter-increment: rank;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: 0.55rem 0 0.55rem 1.8rem;
    border-bottom: 1px solid var(--hairline);
    position: relative;
  }
  .ranking:last-child { border-bottom: none; }
  .ranking::before {
    content: counter(rank);
    position: absolute;
    left: 0.25rem;
    top: 0.6rem;
    font-size: 0.8rem;
    color: var(--whisper);
  }
  .ranking-name { font-size: 0.95rem; }
  .ranking-desc {
    font-size: 0.8rem;
    color: var(--faint);
  }

  /* --- Menu drawer --- */
  .menu-body {
    flex: 1;
    overflow-y: auto;
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  /* anchor styled as a full-width button (see .cbtn in chips.css) */
  .menu-link {
    display: block;
    text-align: center;
    text-decoration: none;
  }
  .menu-sub {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.85rem 0;
    border-top: 1px solid var(--hairline);
    border-bottom: 1px solid var(--hairline);
  }
  .menu-note {
    font-size: 0.9rem;
    line-height: 1.55;
    color: var(--ink-soft);
    margin: 0;
  }
  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .choices .cchoice { flex: 1; }

  .host-controls {
    border-top: 1px solid var(--hairline);
    margin-top: 0.5rem;
    padding-top: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .host-label {
    font-size: 0.75rem;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--whisper);
    margin: 0;
  }

  /* --- Ledger --- */
  .sheet-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.1rem 1.25rem;
    border-bottom: 1px solid var(--hairline);
    max-width: 480px;
    margin-inline: auto;
    width: 100%;
  }
  .ledger-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 1.75rem;
    max-width: 480px;
    margin-inline: auto;
    width: 100%;
  }
  .ledger-empty {
    text-align: center;
    margin-top: 2rem;
  }
  .ledger-hand {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .ledger-hand-label {
    font-family: var(--serif-display);
    font-size: 0.9rem;
    color: var(--ink);
    margin: 0 0 0.35rem;
  }
  .ledger-line {
    font-size: 0.9rem;
    color: var(--ink-soft);
    margin: 0;
  }
  .ledger-street {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 0.4rem 0;
  }
  .ledger-street::before,
  .ledger-street::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--hairline);
  }
  .ledger-street-label {
    font-size: 0.75rem;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--whisper);
  }

  /* --- Bottom sheet (blind schedule) --- */
  .bottom-sheet {
    position: fixed;
    bottom: 0;
    left: 50%;
    transform: translateX(-50%);
    width: min(480px, 100vw);
    max-height: 70dvh;
    overflow-y: auto;
    background: var(--paper);
    border-top: 1px solid var(--rule);
    box-shadow: 0 -8px 30px rgba(42, 42, 42, 0.12);
    z-index: 50;
    padding: 1.25rem 1.25rem calc(1.25rem + env(safe-area-inset-bottom));
  }
  .bottom-sheet-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 0.85rem;
  }
  .bottom-sheet-head p { margin: 0; }
  .sched-list {
    display: flex;
    flex-direction: column;
  }
  .sched-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.55rem 0;
    border-bottom: 1px solid var(--hairline);
    font-size: 0.95rem;
  }
  .sched-row.current { font-weight: 700; }
  .sched-level {
    font-size: 0.8rem;
    color: var(--faint);
    width: 4rem;
  }
  .sched-row.current .sched-level { color: var(--ink); }
  .sched-blinds { flex: 1; text-align: center; }
  .sched-mins {
    font-size: 0.8rem;
    color: var(--faint);
    width: 2.5rem;
    text-align: right;
  }

  /* --- Escalation prompt --- */
  .escalation {
    position: fixed;
    bottom: calc(6.5rem + env(safe-area-inset-bottom));
    left: 50%;
    transform: translateX(-50%);
    width: min(calc(480px - 2.5rem), calc(100vw - 2.5rem));
    background: var(--paper);
    border: 1px solid var(--rule);
    border-radius: 4px;
    box-shadow: 0 8px 30px rgba(42, 42, 42, 0.15);
    padding: 0.85rem 1rem;
    z-index: 30;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .escalation-text { min-width: 0; }
  .escalation-text p { margin: 0; }
  .escalation-title {
    font-size: 0.95rem;
    font-weight: 700;
  }
  .escalation-btns {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  @media (hover: hover) and (pointer: fine) {
    .menu-btn:hover {
      color: var(--ink);
      transition: color 0.1s ease;
    }
    .act:hover:not(:disabled) { opacity: 0.85; }
  }
</style>
