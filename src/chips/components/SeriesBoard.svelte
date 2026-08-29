<script lang="ts">
  import { onMount } from 'svelte';
  import { supabase } from '../lib/supabase';
  import { getSeriesByName } from '../lib/services/series';
  import Leaderboard from './Leaderboard.svelte';
  import type { LifetimeStat, PlayerProfile, SessionResult } from '../lib/types';

  // A live series' board. The name comes from the URL, which in production is a
  // path — /chips/DW-2026-07/leaderboard, rewritten here by vercel.json — and in dev
  // is ?series=, because astro dev does not apply those rewrites. Reading the query
  // first means the same page works under both, and gives a way back in if the
  // rewrite is ever misconfigured.
  function seriesNameFromUrl(): string {
    const fromQuery = new URLSearchParams(window.location.search).get('series');
    if (fromQuery) return fromQuery;
    // /chips/<NAME>/leaderboard — the segment before the last.
    const parts = window.location.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    return last === 'leaderboard' && parts.length >= 2 ? decodeURIComponent(parts[parts.length - 2]) : '';
  }

  let seriesName = $state('');
  let stats = $state<LifetimeStat[]>([]);
  let results = $state<SessionResult[]>([]);
  let profiles = $state<PlayerProfile[]>([]);
  let handCounts = $state<{ identity_id: string; hands: number }[]>([]);
  let loading = $state(true);
  let errorMsg = $state('');

  async function load() {
    try {
      const series = await getSeriesByName(seriesName);
      if (!series) {
        errorMsg = `No series called “${seriesName}”.`;
        return;
      }

      const [statsRes, resultsRes, profilesRes, handsRes] = await Promise.all([
        supabase.from('lifetime_stats').select('*').eq('series_id', series.id),
        supabase.from('session_results').select('*').eq('series_id', series.id),
        // player_profiles and player_stats are keyed by identity and carry no
        // series of their own — a person's playing style is not per-series. They
        // are scoped by intersecting against the identities on this board below,
        // which lifetime_stats has already narrowed to this series' players.
        supabase.from('player_profiles').select('identity_id, profile, coaching, generated_at'),
        supabase.from('player_stats').select('identity_id, hands')
      ]);

      if (statsRes.error) throw statsRes.error;
      stats = (statsRes.data ?? []) as LifetimeStat[];

      const here = new Set(stats.map((s) => s.identity_id));

      // The chart, chaos, blurbs and hand counts are all enhancements over the
      // board: a database missing any of them should still render the standings
      // rather than showing everyone an error.
      if (resultsRes.error) {
        console.warn('session_results unavailable — chart and chaos hidden:', resultsRes.error);
        results = [];
      } else {
        results = (resultsRes.data ?? []) as SessionResult[];
      }
      if (profilesRes.error) {
        console.warn('player_profiles unavailable — blurbs hidden:', profilesRes.error);
        profiles = [];
      } else {
        profiles = ((profilesRes.data ?? []) as PlayerProfile[]).filter((p) =>
          here.has(p.identity_id)
        );
      }
      if (handsRes.error) {
        console.warn('player_stats unavailable — hand counts hidden:', handsRes.error);
        handCounts = [];
      } else {
        handCounts = ((handsRes.data ?? []) as { identity_id: string; hands: number }[]).filter(
          (h) => here.has(h.identity_id)
        );
      }
    } catch (e) {
      console.error('Series board failed to load:', e);
      // Supabase returns a plain PostgrestError object (not an Error), so read its
      // message directly — that's where "relation … does not exist" etc. live.
      const msg = e instanceof Error ? e.message : (e as { message?: string } | null)?.message;
      errorMsg = msg || 'Could not load this series.';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    seriesName = seriesNameFromUrl();
    if (!seriesName) {
      errorMsg = 'No series named in the URL.';
      loading = false;
      return;
    }
    load();
  });
</script>

<Leaderboard
  {stats}
  {results}
  {profiles}
  {handCounts}
  {seriesName}
  {loading}
  {errorMsg}
  onReload={load}
/>
