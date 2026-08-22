<script lang="ts">
  import { niceScale, seriesPath, type NetSeriesData } from '../lib/utils/netSeries';

  interface Props {
    data: NetSeriesData;
    /** identity_id of the line to bring forward, or '' for none. */
    highlighted?: string;
  }

  let { data, highlighted = '' }: Props = $props();

  // A fixed viewBox with preserveAspectRatio="none" would stretch the strokes; instead the
  // SVG scales as a square-ish block and the geometry is computed in viewBox units.
  const W = 320;
  const H = 210;
  const PAD_L = 34; // room for y labels
  const PAD_R = 6;
  const PAD_T = 8;
  const PAD_B = 18; // room for the x caption
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  let scale = $derived(niceScale(data.min, data.max));
  let sessionCount = $derived(data.sessionIds.length);

  function yOf(value: number) {
    const span = scale.max - scale.min || 1;
    return PAD_T + plotH - ((value - scale.min) / span) * plotH;
  }

  function pathFor(s: NetSeriesData['series'][number]) {
    return seriesPath(s, scale, plotW, plotH, sessionCount);
  }

  // Draw the highlighted line last so it sits on top of the others.
  let ordered = $derived(
    highlighted
      ? [
          ...data.series.filter((s) => s.identityId !== highlighted),
          ...data.series.filter((s) => s.identityId === highlighted)
        ]
      : data.series
  );

  function opacityOf(id: string) {
    if (!highlighted) return 1;
    return id === highlighted ? 1 : 0.15;
  }

  const shortDate = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
</script>

{#if sessionCount === 0}
  <p class="cnote">No completed sessions yet.</p>
{:else}
  <svg
    class="net-chart"
    viewBox="0 0 {W} {H}"
    role="img"
    aria-label="Cumulative net over time, one line per player. The same figures are listed below."
  >
    <!-- gridlines + y labels -->
    {#each scale.ticks as tick (tick)}
      <line
        class="grid"
        class:zero={tick === 0}
        x1={PAD_L}
        x2={W - PAD_R}
        y1={yOf(tick)}
        y2={yOf(tick)}
      />
      <text class="axis-label" x={PAD_L - 5} y={yOf(tick)} text-anchor="end" dominant-baseline="middle">
        {tick}
      </text>
    {/each}

    <!-- one line per player -->
    <g transform="translate({PAD_L},{PAD_T})">
      {#each ordered as s (s.identityId)}
        <polyline
          class="series"
          points={pathFor(s)}
          stroke={s.color}
          stroke-dasharray={s.dashed ? '5 3' : undefined}
          opacity={opacityOf(s.identityId)}
        />
      {/each}
    </g>

    <!-- x caption: first and last session, rather than a tick per session -->
    <text class="axis-label" x={PAD_L} y={H - 5}>{shortDate(data.sessionDates[0])}</text>
    {#if sessionCount > 1}
      <text class="axis-label" x={W - PAD_R} y={H - 5} text-anchor="end">
        {shortDate(data.sessionDates[sessionCount - 1])}
      </text>
    {/if}
  </svg>
{/if}

<style>
  .net-chart {
    display: block;
    width: 100%;
    height: auto;
    /* Roughly square, so the chart never eats a mobile screen. */
    aspect-ratio: 320 / 210;
    margin-bottom: 1.25rem;
    overflow: visible;
  }

  .grid {
    stroke: var(--hairline);
    stroke-width: 1;
  }

  /* Break-even is the line everyone reads against, so it gets the ink. */
  .grid.zero {
    stroke: var(--rule);
  }

  .axis-label {
    font-size: 9px;
    fill: var(--faint);
  }

  .series {
    fill: none;
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
    transition: opacity 0.15s ease;
  }
</style>
