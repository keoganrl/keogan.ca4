export const WORDS = [
	'WOLF',
	'BEAR',
	'FOX',
	'HAWK',
	'LION',
	'STAG',
	'CROW',
	'PIKE',
	'LYNX',
	'BULL',
	'BOAR',
	'ROOK',
	'WREN',
	'COLT',
	'KITE'
];

// Codes are a single word, so live games can collide. Callers pass the codes of
// sessions still in play so a fresh game never shadows one someone is joining.
// If every word is taken (15+ concurrent games) we fall back to any word — the
// lookup side resolves duplicates by preferring the newest non-ended session.
export function generateJoinCode(exclude: string[] = []): string {
	const available = WORDS.filter((w) => !exclude.includes(w));
	const pool = available.length ? available : WORDS;
	return pool[Math.floor(Math.random() * pool.length)];
}

export function normalizeCode(input: string): string {
	return input.trim().toUpperCase();
}
