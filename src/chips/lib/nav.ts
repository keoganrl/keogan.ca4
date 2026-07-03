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
