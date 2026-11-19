<script lang="ts">
  import { onMount } from 'svelte';
  import { go } from '../lib/nav';
  import { supabase } from '../lib/supabase';
  import { byNet, netResult, netColor, chipValue, formatAmount } from '../lib/utils/format';
  import { pollForRecap } from '../lib/utils/recapPolling';
  import { openRecapRelay, subscribeToRecap } from '../lib/utils/recapRelay';
  import { getSeriesForSession } from '../lib/services/series';
  import { seriesLeaderboardHref } from '../lib/nav';
  import { balancesFromResults, settleExact, settleRough } from '../lib/utils/settle';
  import type { Player } from '../lib/types';

  let sessionId = $state('');
  let players = $state<Player[]>([]);
  let loading = $state(true);

  // The recap streams in while everyone is still looking at the screen. Failure is
  // silent by design: this is a bonus paragraph over the results, and an error
  // message where a joke should be is worse than no paragraph at all.
  let recap = $state('');
  let recapDone = $state(false);

  // The series this session counted towards, or null if it was a one-off. It decides
  // exactly one thing on this screen now: whether there is a leaderboard to link to.
  // The recap is written either way — a one-off session is still a session, and the
  // paragraph is about the game that just finished rather than about any standings.
  let series = $state<{ id: string; name: string } | null>(null);

  // Dollars per chip if this was a money game, null for chips. Read from the session
  // row; `select('*')` rather than naming money_buyin so a database that predates the
  // column still loads the results (in chips, which is what every such game was).
  let perChip = $state<number | null>(null);
  const m = (chips: number) => formatAmount(chips, perChip);
  const dollars = (cents: number) => formatAmount(cents, 0.01);

  // Who e-transfers whom. Money games only: a chip game has nothing to send. Both
  // versions are worked out up front (a few milliseconds even at a full table) so the
  // tab labels can say how many transfers each one takes.
  const settle = $derived.by(() => {
    if (perChip === null || players.length < 2) return null;
    const { balances, gap } = balancesFromResults(players, perChip);
    return { exact: settleExact(balances), rough: settleRough(balances), gap };
  });
  let settleView = $state<'exact' | 'rough'>('exact');
  const shownSettle = $derived(settle ? settle[settleView] : null);
  const nameOf = (id: string) => players.find((p) => p.id === id)?.display_name ?? '?';
  const plural = (n: number) => `${n} e-transfer${n === 1 ? '' : 's'}`;
  // "Ada $1.20 short, Ben $1.20 ahead": who the rough version leaves off, and which way.
  const offText = (off: { id: string; cents: number }[]) =>
    off
      .map((o) => `${nameOf(o.id)} ${dollars(Math.abs(o.cents))} ${o.cents < 0 ? 'short' : 'ahead'}`)
      .join(', ');

  async function streamRecap(id: string) {
    try {
      const r = await fetch('/api/recap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: id })
      });

      // Another screen got here first and is generating it right now. Only one screen
      // ever does — the row is claimed before the model is called — so this phone
      // waits for the stored copy instead of giving up. Leaving recapDone false keeps
      // the caret blinking, which is honest: it IS still being written, just not here.
      if (r.status === 202) {
        // Live relay from whichever phone is generating, so this screen shows the same
        // words appearing at the same moment rather than a paragraph landing at the end.
        // Longest-wins because messages carry the whole paragraph so far: an out-of-order
        // one cannot rewind the text.
        let relayFinished: (text: string) => void;
        const relayDone = new Promise<string>((resolve) => (relayFinished = resolve));
        const stopListening = subscribeToRecap(id, (text, done) => {
          if (text.length > recap.length) recap = text;
          // The generating phone says that was the last of it, so stop the caret now
          // rather than a poll interval later, when the stored copy confirms what this
          // screen is already showing.
          if (done) relayFinished(text);
        });

        // The stored copy underneath it all. This is what makes the relay optional: if
        // the generating phone left, locked, or finished before this one subscribed,
        // the poll still returns the finished text. It doubles as the "it is done"
        // signal, since the row is only written once generation completes.
        try {
          const stored = await Promise.race([
            relayDone,
            pollForRecap(async () => {
              const { data, error } = await supabase
                .from('session_recaps')
                .select('recap')
                .eq('session_id', id)
                .maybeSingle();
              if (error) throw error;
              return data as { recap: string | null } | null;
            })
          ]);
          if (stored && stored.length > recap.length) recap = stored;
        } finally {
          stopListening();
        }
        recapDone = true;
        return;
      }

      // A recap written earlier comes back as JSON rather than a stream.
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

      // This phone won the claim, so it is the one reading the model's output — and the
      // only one that can show it to the others as it arrives.
      const relay = openRecapRelay(id);
      try {
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          recap += decoder.decode(value, { stream: true });
          relay.send(recap);
        }
        // Forced through the throttle: this is the message carrying the complete text,
        // and the one that tells the other phones to stop their caret.
        relay.send(recap, true);
      } finally {
        relay.close();
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

    // Fetched together rather than in sequence: the results and the Leaderboard
    // button want to appear at the same moment, and neither should wait on the other.
    const [{ data }, seriesRow, { data: sessionRow }] = await Promise.all([
      supabase.from('players').select('*').eq('session_id', sessionId).order('seat_order'),
      getSeriesForSession(sessionId).catch(() => null),
      supabase.from('sessions').select('*').eq('id', sessionId).maybeSingle()
    ]);
    perChip = chipValue(sessionRow);

    // Ranked by NET, not by final stack: a rebuy makes the two disagree, and the
    // number in the right-hand column is the net — so ordering by stack put someone
    // who bought in twice and finished down 810 above a player down 400. PostgREST
    // cannot order by an expression, hence the sort here (seat_order above is only
    // to make the pre-sort order deterministic; ties break by name).
    if (data) players = [...(data as Player[])].sort(byNet);
    series = seriesRow;
    loading = false;

    // Every session gets one, single or series alike. The endpoint decides whether
    // there is anything worth writing about (two players, five dealt hands) and
    // whether this phone is the one generating it; all this has to do is ask.
    //
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
    <!-- recapDone starts false, so the caret is showing from the first paint. That is
         honest for every session now that every session asks: something IS being
         written. A session too small to be worth a paragraph gets a 422, which sets
         recapDone without any text, and the block disappears. -->
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
            <span class="who-detail">bought in {m(player.total_buyin)} · finished {m(player.stack)}</span>
          </span>
          <span class="net {netColor(player.stack, player.total_buyin)}">
            {netResult(player.stack, player.total_buyin, perChip)}
          </span>
        </li>
      {/each}
    </ul>

    {#if settle && shownSettle}
      {@const saved = settle.exact.transfers.length - settle.rough.transfers.length}
      <section class="settle" aria-label="Settle up">
        <h2 class="clabel">Settle up</h2>
        <div class="choices">
          <button
            class="cchoice grow"
            class:active={settleView === 'exact'}
            onclick={() => (settleView = 'exact')}
            >Exact · {settle.exact.transfers.length}</button
          >
          <button
            class="cchoice grow"
            class:active={settleView === 'rough'}
            onclick={() => (settleView = 'rough')}
            >Rough · {settle.rough.transfers.length}</button
          >
        </div>

        {#if shownSettle.transfers.length === 0}
          <p class="cnote settle-note">Nobody owes anybody.</p>
        {:else}
          <ul class="transfers">
            {#each shownSettle.transfers as t, i (i)}
              <li class="transfer">
                <span class="transfer-who">
                  {nameOf(t.from)} <span class="arrow" aria-label="sends">→</span>
                  {nameOf(t.to)}
                </span>
                <span class="transfer-amt">{dollars(t.cents)}</span>
              </li>
            {/each}
          </ul>
        {/if}

        <p class="cnote settle-note">
          {#if settleView === 'exact'}
            The fewest e-transfers that settle everyone to the cent.
          {:else if saved > 0}
            {plural(saved)} fewer than exact, for {dollars(settle.rough.misallocated)} in the
            wrong pocket:
            {offText(settle.rough.off)}.
          {:else if settle.rough.misallocated > 0}
            Can't be done in fewer, so this is exact rounded to whole dollars:
            {offText(settle.rough.off)}.
          {:else}
            Can't be done in fewer. Same as exact.
          {/if}
        </p>
        {#if settle.gap !== 0}
          <p class="cnote settle-note">
            The table finished {dollars(Math.abs(settle.gap))}
            {settle.gap > 0 ? 'over' : 'short'}, so {settle.gap > 0 ? 'winners' : 'losers'} were
            trimmed evenly to make it balance.
          </p>
        {/if}
      </section>
    {/if}

    <div class="actions">
      <a class="cbtn" href="/chips">Home</a>
      {#if series}
        <a class="cbtn" href={seriesLeaderboardHref(series.name)}>Leaderboard</a>
      {/if}
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

  .settle {
    margin: -1rem 0 3rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .settle h2 {
    margin: 0;
  }

  .choices {
    display: flex;
    gap: 0.5rem;
  }
  .grow { flex: 1; }

  .transfers {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .transfer {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.7rem 0;
    border-bottom: 1px solid var(--hairline);
  }

  .arrow {
    color: var(--faint);
    margin: 0 0.25rem;
  }

  .transfer-amt {
    font-weight: 700;
    flex-shrink: 0;
  }

  .settle-note {
    margin: 0;
    font-size: 0.8rem;
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
