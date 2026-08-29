// The app lives under /chips but its internal links are written root-relative
// ('/setup?session=…'), matching the original standalone deployment.
const BASE = '/chips';

export function go(path: string, opts: { replace?: boolean } = {}): void {
  const url = path === '/' ? BASE : `${BASE}${path}`;
  if (opts.replace) window.location.replace(url);
  else window.location.href = url;
}

/** Absolute invite URL for a join code, e.g. https://keogan.ca/chips/WOLF */
export function inviteUrl(code: string): string {
  return `${window.location.origin}${BASE}/${code}`;
}

/**
 * Link to a series' leaderboard.
 *
 * In production this is a real path, `/chips/DW-2026-07/leaderboard`, served either
 * by a prerendered page (for an ended series, built from its committed archive) or
 * through the vercel.json rewrite to /chips/series for a live one.
 *
 * `astro dev` does not apply vercel.json rewrites, so in dev that path 404s for
 * every live series. The page reads ?series= first for exactly this reason, and
 * that query form doubles as the fallback if the rewrite is ever misconfigured.
 */
export function seriesLeaderboardHref(name: string): string {
	return import.meta.env.DEV
		? `${BASE}/series?series=${encodeURIComponent(name)}`
		: `${BASE}/${encodeURIComponent(name)}/leaderboard`;
}
