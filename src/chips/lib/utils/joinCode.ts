// Short, unambiguous animal names — easy to say across a table and to type on a
// phone. Every word here becomes a prerendered invite URL (see
// src/pages/chips/[code].astro), so adding one is free but never remove one that
// might still be shared somewhere.
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
	'KITE',
	'OTTER',
	'BISON',
	'MOOSE',
	'HERON',
	'RAVEN',
	'EGRET',
	'VIPER',
	'COBRA',
	'GECKO',
	'STOAT',
	'SHREW',
	'TAPIR',
	'ZEBRA',
	'PANDA',
	'KOALA',
	'DINGO',
	'ORCA',
	'PUMA',
	'MOLE',
	'SEAL',
	'TOAD',
	'NEWT',
	'CRAB',
	'DOVE',
	'SWAN',
	'IBIS',
	'MOTH',
	'WASP',
	'HARE',
	'GOAT'
];

// Codes are a single word, so live games can collide. Callers pass the codes of
// sessions still in play so a fresh game never shadows one someone is joining.
// If every word is taken (more concurrent games than WORDS has entries) we fall
// back to any word — the lookup side resolves duplicates by preferring the
// newest non-ended session.
export function generateJoinCode(exclude: string[] = []): string {
	const available = WORDS.filter((w) => !exclude.includes(w));
	const pool = available.length ? available : WORDS;
	return pool[Math.floor(Math.random() * pool.length)];
}

export function normalizeCode(input: string): string {
	return input.trim().toUpperCase();
}
