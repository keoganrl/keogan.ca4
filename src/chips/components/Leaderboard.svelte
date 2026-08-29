<script lang="ts">
  import { onMount } from 'svelte';
  import { supabase } from '../lib/supabase';
  import { mergeIdentities } from '../lib/services/game';
  import { initIdentity, displayName, identityId } from '../lib/stores/identity';
  import {
    sortLifetimeStats,
    type LeaderboardSortKey
  } from '../lib/utils/leaderboard';
  import { buildNetSeries } from '../lib/utils/netSeries';
  import { chaosScores, MIN_CHAOS_SESSIONS } from '../lib/utils/chaos';
  import { statSections } from '../lib/utils/playerStats';
  import NetChart from './NetChart.svelte';
  import type {
    LifetimeStat,
    PlayerProfile,
    PlayerStat,
    SessionResult
  } from '../lib/types';

  // The board renders what it is given and fetches nothing. Two callers supply the
  // data: SeriesBoard.svelte queries a live series, and the archived route passes a
  // committed snapshot straight through from its Astro frontmatter. Keeping the
  // fetching outside is what lets an ended series render as static HTML with no
  // database behind it at all.
  interface Props {
    /** Series-scoped lifetime_stats rows — the five sort tabs. */
    stats: LifetimeStat[];
    /** Series-scoped session_results rows — the net chart and the chaos tab. */
    results: SessionResult[];
    profiles: PlayerProfile[];
    handCounts: { identity_id: string; hands: number }[];
    seriesName: string;
    /**
     * An ended series, rendered from its committed archive. Frozen boards have no
     * live rows behind them, so anything that reads or writes the database is off:
     * the merge tool, and the on-demand fetch of your own detailed stats.
     */
    frozen?: boolean;
    endedAt?: string | null;
    /**
     * Every player's full player_stats row. Only supplied for a frozen board, where
     * the detail panel cannot go and fetch one. Live boards leave it out and fetch
     * just the viewer's own row when they open their card.
     */
    playerStats?: PlayerStat[];
    loading?: boolean;
    errorMsg?: string;
    /** Re-fetch after a merge. Live boards only — a frozen one has nothing to merge. */
    onReload?: () => void | Promise<void>;
  }

  let {
    stats,
    results,
    profiles,
    handCounts,
    seriesName,
    frozen = false,
    endedAt = null,
    playerStats = [],
    loading = false,
    errorMsg = '',
    onReload
  }: Props = $props();

  // The five stat columns are all sorts of the same board; 'chaos' and 'profiles'
  // each have their own rows, so they are tabs rather than more sorts.
  type Tab = LeaderboardSortKey | 'chaos' | 'profiles';

  let sortBy = $state<Tab>('total_net');
  // Tapping a name dims every other line — the only reliable way to pick one player
  // out once there are more than a handful on the chart.
  let highlighted = $state('');

  onMount(() => {
    // Populates $displayName from this device's saved identity — the merge tool
    // below is gated on it, and it is how a row knows it is yours.
    initIdentity();
  });

  // Merging rewrites other people's history, so the tool is only offered on the
  // owner's device. Deliberately soft: the name lives in localStorage and anyone
  // who wanted to could set it, so this hides a footgun from guests rather than
  // enforcing a permission.
  const OWNER_NAME = 'keogan';
  // Never on a frozen board: its rows were archived from a database that no longer
  // holds them, so a merge there would rewrite nothing and mean nothing.
  let isOwner = $derived(!frozen && $displayName.trim().toLowerCase() === OWNER_NAME);

  // Merge mode: collapse duplicate identities (someone who joins from a private tab
  // gets a fresh identity every visit, so one human shows up several times). Select
  // the rows that are the same person, then pick which name survives.
  let mergeMode = $state(false);
  let selectedIds = $state<string[]>([]);
  let choosingKeep = $state(false);
  let merging = $state(false);

  const selectedStats = $derived(stats.filter((s) => selectedIds.includes(s.identity_id)));

  function toggleSelect(id: string) {
    if (choosingKeep) return;
    selectedIds = selectedIds.includes(id)
      ? selectedIds.filter((x) => x !== id)
      : [...selectedIds, id];
  }

  function exitMergeMode() {
    mergeMode = false;
    selectedIds = [];
    choosingKeep = false;
  }

  async function confirmMerge(keepId: string) {
    if (merging) return;
    merging = true;
    try {
      await mergeIdentities(
        keepId,
        selectedIds.filter((id) => id !== keepId)
      );
      await onReload?.();
      exitMergeMode();
    } finally {
      merging = false;
    }
  }

  // Profiles tab. The roster is everyone; the expanding card is yours alone.
  // $identityId is this device's UUID and matches lifetime_stats.identity_id
  // directly, so "is this row me?" needs no lookup. Note this hides UI, it does
  // not protect data — the anon key can read the whole view, same as the rest of
  // the app. That is the intended trust model here, not an oversight.
  let expanded = $state(false);
  let myStats = $state<PlayerStat | null>(null);
  let myStatsState = $state<'idle' | 'loading' | 'ready' | 'missing' | 'error'>('idle');

  const isMe = (id: string) => id === $identityId && $identityId !== '';

  // Fetched only when you open your own card, and only your own row: no reason to
  // pull the whole view for a panel that shows one player.
  async function loadMyStats() {
    if (myStatsState === 'loading' || myStatsState === 'ready') return;
    myStatsState = 'loading';

    // A frozen board carries every player's row in its snapshot, because there is no
    // database left to ask. Live boards fetch only the viewer's own row.
    if (frozen) {
      myStats = playerStats.find((s) => s.identity_id === $identityId) ?? null;
      myStatsState = myStats ? 'ready' : 'missing';
      return;
    }

    const { data, error } = await supabase
      .from('player_stats')
      .select('*')
      .eq('identity_id', $identityId)
      .maybeSingle();
    if (error) {
      console.warn('player_stats unavailable:', error);
      myStatsState = 'error';
      return;
    }
    myStats = (data as PlayerStat | null) ?? null;
    // No row is the ordinary case for someone whose games predate the ledger, so
    // it gets its own state rather than being reported as a failure.
    myStatsState = myStats ? 'ready' : 'missing';
  }

  function toggleExpanded() {
    expanded = !expanded;
    if (expanded) loadMyStats();
  }

  let handsOf = $derived(new Map(handCounts.map((h) => [h.identity_id, h.hands])));

  // Most hands first. Hands rather than sessions because that is what the profiles
  // are actually written from — someone who turned up twice and played 150 hands has
  // a fuller profile than someone who turned up ten times and played 30. Ties fall
  // back to name so the order is stable between loads.
  let roster = $derived(
    [...stats].sort((a, b) => {
      const diff = (handsOf.get(b.identity_id) ?? 0) - (handsOf.get(a.identity_id) ?? 0);
      return diff !== 0 ? diff : a.display_name.localeCompare(b.display_name);
    })
  );

  function handsLabel(id: string) {
    const n = handsOf.get(id);
    if (!n) return 'no hands recorded';
    return `${n} hand${n === 1 ? '' : 's'}`;
  }

  let sections = $derived(myStats ? statSections(myStats) : []);
  let profileOf = $derived(new Map(profiles.map((p) => [p.identity_id, p])));

  let sorted = $derived(
    sortBy === 'chaos' || sortBy === 'profiles'
      ? []
      : sortLifetimeStats(stats, sortBy as LeaderboardSortKey)
  );
  let netData = $derived(buildNetSeries(results));
  let chaos = $derived(chaosScores(results));
  // identity_id -> the colour of that player's line, so the list doubles as the legend.
  let colorOf = $derived(
    new Map(netData.series.map((s) => [s.identityId, { color: s.color, dashed: s.dashed }]))
  );

  const columns: { key: Tab; label: string }[] = [
    // Profiles leads the row but is not the default — sortBy starts on 'total_net',
    // so the page still opens on the board and this is the first thing beside it.
    { key: 'profiles', label: 'profiles' },
    { key: 'total_net', label: 'net' },
    { key: 'biggest_win', label: 'best win' },
    { key: 'times_first', label: 'times first' },
    { key: 'times_last', label: 'times last' },
    { key: 'all_ins', label: 'all-ins' },
    { key: 'chaos', label: 'chaos' }
  ];

  function toggleHighlight(id: string) {
    highlighted = highlighted === id ? '' : id;
  }

  function netClass(val: number) {
    return val > 0 ? 'net-up' : val < 0 ? 'net-down' : 'net-even';
  }

  function netStr(val: number) {
    return val > 0 ? `+${val}` : `${val}`;
  }
</script>

<div class="chips-page">
  <p class="chips-back"><a href="/chips/leaderboard">← series</a></p>
  <h1 class="chips-title">{seriesName}</h1>
  <p class="chips-sub">
    {#if frozen}
      Final standings{endedAt ? ` — ended ${new Date(endedAt).toLocaleDateString()}` : ''}
    {:else}
      Records across this series
    {/if}
  </p>

  <nav class="sorts">
    {#each columns as col (col.key)}
      <button class="cchoice" class:active={sortBy === col.key} onclick={() => (sortBy = col.key)}>
        {col.label}
      </button>
    {/each}
  </nav>

  {#if loading}
    <p class="cnote">Loading…</p>
  {:else if errorMsg}
    <p class="cerror">Couldn’t load this series — {errorMsg}</p>
  {:else if stats.length === 0}
    <p class="cnote">No completed sessions yet.</p>
  {:else if sortBy === 'chaos'}
    <p class="cnote explainer">Standard deviation of results across sessions</p>
    {#if chaos.length === 0}
      <p class="cnote">No completed sessions yet.</p>
    {:else}
      <ul class="board">
        {#each chaos as p, i (p.identityId)}
          <li class="board-row" class:first={i === 0 && p.qualified}>
            <span class="rank">{p.qualified ? i + 1 : '·'}</span>
            <span class="who">
              <span class="who-name">{p.displayName}</span>
              <span class="who-detail">
                {#if !p.qualified}
                  needs {MIN_CHAOS_SESSIONS - p.sessionsPlayed} more session{MIN_CHAOS_SESSIONS - p.sessionsPlayed === 1 ? '' : 's'}
                {:else}
                  best +{Math.round(p.bestSession)}bb · worst {Math.round(p.worstSession)}bb
                {/if}
              </span>
            </span>
            <span class="stat">
              <!-- The figure is the standard deviation itself, so the label gives its
                   unit rather than implying a ceiling it doesn't have. -->
              <span class="stat-num">{p.qualified ? Math.round(p.swing) : '—'}</span>
              <span class="stat-label">{p.qualified ? 'bb swing' : 'not enough data'}</span>
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  {:else if sortBy === 'profiles'}
    <p class="cnote explainer">Tap your own name to see your numbers</p>
    <ul class="board">
      {#each roster as player (player.identity_id)}
        <li class="board-row profile-row" class:mine={isMe(player.identity_id)}>
          {#if isMe(player.identity_id)}
            <button class="row-btn" aria-expanded={expanded} onclick={toggleExpanded}>
              <span class="who">
                <span class="who-name">{player.display_name}</span>
                <span class="who-detail">you · {handsLabel(player.identity_id)}</span>
                {#if profileOf.get(player.identity_id)?.profile}
                  <span class="blurb">{profileOf.get(player.identity_id)!.profile}</span>
                {/if}
              </span>
              <!-- Rotates to point down when open; aria-expanded above is what
                   actually announces the state, so this is decorative. -->
              <span class="chev" class:open={expanded} aria-hidden="true">›</span>
            </button>
          {:else}
            <div class="row-static">
              <span class="who">
                <span class="who-name">{player.display_name}</span>
                <span class="who-detail">{handsLabel(player.identity_id)}</span>
                {#if profileOf.get(player.identity_id)?.profile}
                  <span class="blurb">{profileOf.get(player.identity_id)!.profile}</span>
                {/if}
              </span>
            </div>
          {/if}

          {#if isMe(player.identity_id) && expanded}
            <div class="panel">
              {#if profileOf.get(player.identity_id)?.coaching}
                <!-- Only ever rendered inside your own row, which is the only row that
                     opens. Coaching is written to be read by the person it is about. -->
                <div class="coaching">
                  <h3 class="panel-title">What to work on</h3>
                  <p>{profileOf.get(player.identity_id)!.coaching}</p>
                </div>
              {/if}
              {#if myStatsState === 'loading'}
                <p class="cnote">Loading…</p>
              {:else if myStatsState === 'error'}
                <p class="cnote">Couldn’t load your stats.</p>
              {:else if myStatsState === 'missing'}
                <p class="cnote">No hands recorded yet — play a game and check back.</p>
              {:else if sections.length === 0}
                <p class="cnote">Not enough hands yet to say anything useful.</p>
              {:else}
                {#each sections as section (section.title)}
                  <h3 class="panel-title">{section.title}</h3>
                  <dl class="statlist">
                    {#each section.rows as row (row.label)}
                      <div class="statline">
                        <dt>
                          <span class="statline-label">{row.label}</span>
                          <span class="statline-hint">{row.hint}</span>
                        </dt>
                        <dd>
                          <span class="statline-value">{row.value}</span>
                          <!-- The denominator is the honest half of a percentage: 100%
                               over three spots and 100% over three hundred are not the
                               same claim, and only this line tells them apart. -->
                          <span class="statline-basis">
                            {row.confidence === 'anecdote' ? 'only ' : ''}{row.basis}
                          </span>
                        </dd>
                      </div>
                    {/each}
                  </dl>
                {/each}
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    {#if sortBy === 'total_net' && netData.series.length > 0}
      <NetChart data={netData} {highlighted} />
    {/if}
    {#if mergeMode}
      <p class="cnote merge-hint">
        {choosingKeep
          ? 'Pick the name to keep — the others fold into it.'
          : 'Tap every entry that belongs to the same person.'}
      </p>
    {/if}
    <ul class="board">
      {#each sorted as player, i (player.identity_id)}
        <li
          class="board-row"
          class:first={i === 0 && !mergeMode}
          class:selectable={mergeMode && !choosingKeep}
          class:selected={mergeMode && selectedIds.includes(player.identity_id)}
          class:lit={!mergeMode && highlighted === player.identity_id}
        >
          <!-- The whole row is one button: a real <button> rather than a clickable <li>,
               so it is keyboard-reachable and announced correctly. Outside merge mode it
               highlights this player's line on the chart; inside it, it selects for merging. -->
          <button
            class="row-btn"
            aria-pressed={mergeMode
              ? selectedIds.includes(player.identity_id)
              : highlighted === player.identity_id}
            onclick={() =>
              mergeMode ? toggleSelect(player.identity_id) : toggleHighlight(player.identity_id)}
          >
          <span class="rank">{i + 1}</span>
          <span class="who">
            <span class="who-name">
              <!-- Only the net tab shows swatches: there they are the chart's legend and
                   carry meaning. On the other tabs there is no chart to key them to, so
                   they would be colour for its own sake. -->
              {#if sortBy === 'total_net' && colorOf.has(player.identity_id)}
                <span
                  class="swatch"
                  class:dashed={colorOf.get(player.identity_id)!.dashed}
                  style="--swatch: {colorOf.get(player.identity_id)!.color}"
                ></span>
              {/if}{player.display_name}
            </span>
            <span class="who-detail">
              {player.sessions_played} session{player.sessions_played === 1 ? '' : 's'}
            </span>
          </span>
          <span class="stat">
            {#if sortBy === 'total_net'}
              <span class="stat-num {netClass(player.total_net)}">{netStr(player.total_net)}</span>
              <!-- "series net", not "lifetime": the board is scoped to one series
                   now, and this figure only covers the sessions in it. -->
              <span class="stat-label">series net</span>
            {:else if sortBy === 'times_first'}
              <span class="stat-num net-up">{player.times_first ?? 0}</span>
              <span class="stat-label">times first</span>
            {:else if sortBy === 'biggest_win'}
              <span class="stat-num {netClass(player.biggest_win)}">{netStr(player.biggest_win)}</span>
              <span class="stat-label">best session</span>
            {:else if sortBy === 'all_ins'}
              <span class="stat-num">{player.all_ins ?? 0}</span>
              <span class="stat-label">all-ins</span>
            {:else}
              <span class="stat-num net-down">{player.times_last}</span>
              <span class="stat-label">times last</span>
            {/if}
          </span>
          </button>
        </li>
      {/each}
    </ul>

    <!-- Duplicate cleanup: joins from a private tab mint a fresh identity each
         visit, so the same person can appear several times. Owner-only — see
         isOwner above. -->
    {#if isOwner}
      <div class="merge-controls">
        {#if !mergeMode}
          {#if stats.length > 1}
            <button class="cbtn cbtn-small" onclick={() => (mergeMode = true)}>
              Merge duplicate players
            </button>
          {/if}
        {:else if choosingKeep}
          <div class="keep-picker">
            {#each selectedStats as s (s.identity_id)}
              <button
                class="cbtn"
                onclick={() => confirmMerge(s.identity_id)}
                disabled={merging}
              >
                Keep “{s.display_name}”
              </button>
            {/each}
            <button class="cbtn cbtn-small" onclick={() => (choosingKeep = false)} disabled={merging}
              >Back</button
            >
          </div>
        {:else}
          <div class="keep-picker">
            <button
              class="cbtn cbtn-primary"
              onclick={() => (choosingKeep = true)}
              disabled={selectedIds.length < 2}
            >
              Merge {selectedIds.length < 2 ? 'selected' : `${selectedIds.length} entries`}…
            </button>
            <button class="cbtn cbtn-small" onclick={exitMergeMode}>Cancel</button>
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  /* One row that scrolls sideways rather than wrapping to two. The negative margin
     cancels .chips-page's padding so the row spans the full width and a chip is clipped
     by the screen edge — that half-visible chip is the only affordance saying there is
     more to the right, so the bleed is load-bearing, not decoration. The matching
     padding keeps the first chip aligned with the text above it. */
  /* The gap the tab row leaves beneath itself. Named because .explainer cancels it
     back out, and the two have to move together. */
  .chips-page {
    --tab-gap: 2.5rem;
  }

  .sorts {
    display: flex;
    flex-wrap: nowrap;
    gap: 0.5rem;
    margin: 0 -1.75rem var(--tab-gap);
    padding-inline: 1.75rem;
    overflow-x: auto;
    /* A horizontal scroller at the edge of an iOS viewport otherwise hands the gesture
       to the browser's back-swipe halfway through a drag. */
    overscroll-behavior-x: contain;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }

  .sorts::-webkit-scrollbar {
    display: none;
  }

  /* Chips keep their natural width; without this they compress to fit instead of
     overflowing, and nothing ever scrolls. */
  .sorts :global(.cchoice) {
    flex-shrink: 0;
  }

  .board {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .board-row {
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

  .who-name {
    font-size: 1.05rem;
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }

  /* The list is the chart's legend: identity is never colour alone, always a swatch
     beside the name. This is also what licenses the three lighter palette slots,
     which fall under 3:1 contrast against the paper on their own. */
  .swatch {
    flex-shrink: 0;
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 50%;
    background: var(--swatch);
    /* Past the eighth player the palette repeats with a dashed stroke; the ring
       mirrors that so the swatch and its line still read as the same series. */
    box-shadow: inset 0 0 0 2px var(--paper);
  }

  .swatch:not(.dashed) {
    box-shadow: none;
  }

  /* The row button carries the layout; it must not look like a control. */
  .row-btn {
    flex: 1;
    display: flex;
    align-items: baseline;
    gap: 1rem;
    width: 100%;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .row-btn:focus-visible {
    outline: 2px solid var(--rule);
    outline-offset: 3px;
    border-radius: 3px;
  }

  .board-row.lit {
    background: var(--hairline);
    border-radius: 4px;
  }

  /* The blurb is a subtitle for the selected tab, so it sits just under the tabs —
     a shade looser than the 0.5rem .chips-sub leaves under .chips-title, because the
     tab row's rounded chips carry more visual weight than a line of text does.
     Written as a cancellation of --tab-gap rather than a bare negative value so it
     stays correct if the tab spacing changes; the negative margin collapses against
     the tab row's positive one to leave the difference. */
  .explainer {
    margin: calc(0.9rem - var(--tab-gap)) 0 1.5rem;
    max-width: 34rem;
  }
  .first .who-name {
    font-family: var(--serif-display);
    font-weight: 700;
  }

  .who-detail {
    font-size: 0.8rem;
    color: var(--faint);
  }

  .stat {
    text-align: right;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .stat-num {
    font-size: 1.15rem;
    font-weight: 700;
  }

  .stat-label {
    font-size: 0.75rem;
    color: var(--faint);
  }

  /* --- Merge mode --- */
  .merge-hint {
    margin: 0 0 1rem;
    font-style: italic;
  }
  .board-row.selectable {
    cursor: pointer;
    user-select: none;
  }
  .board-row.selected {
    background: var(--hairline);
    outline: 1px solid var(--rule);
    border-radius: 4px;
    padding-left: 0.5rem;
    padding-right: 0.5rem;
  }
  .merge-controls {
    margin-top: 2rem;
  }
  .keep-picker {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  /* Profiles tab. A row here stacks — the header line, then the panel it opens —
     so it overrides .board-row's default side-by-side layout. */
  .profile-row {
    flex-direction: column;
    align-items: stretch;
    gap: 0;
  }

  /* Everyone else's row is inert: no button, no pointer, nothing that suggests it
     opens. Matching .row-btn's box keeps the two kinds of row on one rhythm. */
  .row-static {
    display: flex;
    align-items: baseline;
    gap: 1rem;
    width: 100%;
  }

  .profile-row .row-btn {
    align-items: center;
  }

  .profile-row .who-detail {
    color: var(--faint);
  }

  .chev {
    color: var(--faint);
    font-size: 1.6rem;
    line-height: 1;
    transition: transform 0.15s ease;
  }

  .chev.open {
    transform: rotate(90deg);
  }

  @media (prefers-reduced-motion: reduce) {
    .chev {
      transition: none;
    }
  }

  /* No padding of its own: every heading inside carries the same top margin, so the
     gap beneath the blurb matches the gaps between the sections below it. */
  .panel {
    padding: 0 0 0.4rem;
    padding-left: var(--profile-indent);
  }

  /* The blurb is the point of this tab, so it gets body-text weight rather than the
     muted treatment the metadata line above it uses. It and the panel below are
     indented a little past the name, which stays flush: the step is what tells you
     at a glance that the text belongs to the person above it rather than floating
     between two of them. */
  .profile-row {
    --profile-indent: 1rem;
  }

  .blurb {
    display: block;
    margin-top: 0.4rem;
    padding-left: var(--profile-indent);
    max-width: 34rem;
    color: var(--ink-soft);
    white-space: normal;
  }

  /* The next heading's own top margin provides the separation. */
  .coaching {
    margin-bottom: 0;
  }

  .coaching p {
    margin: 0;
    max-width: 34rem;
    color: var(--ink-soft);
  }

  .panel-title {
    font-family: var(--serif-display);
    font-size: 0.8rem;
    font-weight: normal;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--faint);
    margin: 1.4rem 0 0.5rem;
  }

  .statlist {
    margin: 0;
  }

  .statline {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.45rem 0;
    border-bottom: 1px solid var(--hairline);
  }

  .statline:last-child {
    border-bottom: 0;
  }

  .statline dt {
    min-width: 0;
  }

  .statline dd {
    margin: 0;
    text-align: right;
    flex-shrink: 0;
  }

  .statline-label,
  .statline-value {
    display: block;
  }

  .statline-value {
    font-variant-numeric: tabular-nums;
  }

  .statline-hint,
  .statline-basis {
    display: block;
    font-size: 0.75rem;
    color: var(--faint);
    margin-top: 0.15rem;
  }
</style>
