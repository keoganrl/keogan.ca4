/**
 * Waiting for a recap another screen is already writing.
 *
 * Only one screen generates: api/recap.js claims the row before it calls the model,
 * so the first phone to load the game-over page streams the text and every other
 * phone is told "already generating" (202). Those phones have to wait for the stored
 * copy — the alternative is what shipped first, where they blinked a caret for a
 * moment and then showed nothing at all until someone reloaded.
 *
 * Polling rather than realtime: it needs no publication change, it cannot silently
 * do nothing on a database that has not had a migration run, and the wait is only
 * the few seconds the model takes. Each poll is one primary-key read.
 */

/** What the caller's fetcher returns: the row, or null when there is no row. */
export type RecapRow = { recap: string | null } | null;

export interface PollOptions {
	intervalMs?: number;
	timeoutMs?: number;
	/** Injected for tests, so they need no real timers. */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

/**
 * Polls until the recap appears, and returns it. Returns null when it is not coming.
 *
 * Three ways to stop, and all of them are silent by design — this is a bonus
 * paragraph over the results, and an error where a joke should be is worse than no
 * paragraph:
 *   * the row has gone: the generating screen's attempt failed and released its
 *     claim, so nothing is on its way and a later visit will start a fresh attempt;
 *   * the fetch threw: a phone that has lost the network has bigger problems;
 *   * the deadline passed.
 *
 * The first poll waits before reading, deliberately. This is only ever called after
 * a 202, which means the row existed a moment ago with nothing in it yet.
 */
export async function pollForRecap(
	fetchRow: () => Promise<RecapRow>,
	opts: PollOptions = {}
): Promise<string | null> {
	const intervalMs = opts.intervalMs ?? 1200;
	// Long enough for a slow generation on a full table, short enough that a screen
	// left open on a dead claim gives up rather than polling all night. A claim that
	// outlives its function is reclaimed by the next visit anyway (api/recap.js
	// treats one older than a few minutes as abandoned).
	const timeoutMs = opts.timeoutMs ?? 90_000;
	const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const now = opts.now ?? (() => Date.now());

	const deadline = now() + timeoutMs;

	while (now() < deadline) {
		await sleep(intervalMs);

		let row: RecapRow;
		try {
			row = await fetchRow();
		} catch {
			return null;
		}

		if (row === null) return null;
		if (row.recap) return row.recap;
	}

	return null;
}
