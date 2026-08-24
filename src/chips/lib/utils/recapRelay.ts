/**
 * Relaying a recap to every phone at the table as it is written.
 *
 * Only one screen generates: api/recap.js claims the row before calling the model, so
 * the first phone to reach the game-over page gets the stream and the rest get a 202.
 * That phone relays what it is reading over a Supabase realtime BROADCAST channel, and
 * the others render it live. Everyone watches the same paragraph appear at once, which
 * is the whole point of streaming it in a room full of people.
 *
 * Broadcast, not postgres_changes: it is ephemeral pub/sub over the websocket the app
 * already holds open, so it needs no table, no publication change, and no migration.
 *
 * ---------------------------------------------------------------------------
 * CUMULATIVE, NOT DELTAS
 * ---------------------------------------------------------------------------
 * Every message carries the whole paragraph so far rather than the newest fragment.
 * That costs a little bandwidth (a recap is a paragraph) and buys three things:
 *   * a message that arrives out of order cannot scramble the text — the receiver
 *     keeps whichever is longer;
 *   * a dropped message repairs itself on the very next one;
 *   * a phone that subscribes late — it was still waiting on its own 202 while the
 *     generator was already three sentences in — catches up on its first message
 *     instead of showing a paragraph with the beginning missing.
 *
 * None of this is load-bearing for correctness. The relay is a nicety over the stored
 * copy: if it never speaks at all, the receiving phones still fall back to polling
 * session_recaps and show the finished text (see recapPolling.ts).
 */
import { supabase } from '../supabase';

const EVENT = 'chunk';
const channelName = (sessionId: string) => `recap:${sessionId}`;

/** How often the generating phone is allowed to relay, in ms. */
const RELAY_INTERVAL_MS = 100;

/**
 * A rate limiter that answers "may I send now?".
 *
 * Model output arrives in many small deltas a second. Relaying every one would put
 * hundreds of messages on the channel for a single paragraph, to no visible benefit:
 * ten updates a second already reads as typing. `force` is for the final message,
 * which must never be dropped — it is the one carrying the complete text.
 */
export function makeThrottle(intervalMs: number, now: () => number = () => Date.now()) {
	let last = -Infinity;
	return (force = false): boolean => {
		const t = now();
		if (!force && t - last < intervalMs) return false;
		last = t;
		return true;
	};
}

export interface RecapRelay {
	/** Relay the paragraph so far. `done` forces the send and marks it final. */
	send: (text: string, done?: boolean) => void;
	close: () => void;
}

/** Opens the relay on the generating phone. */
export function openRecapRelay(sessionId: string): RecapRelay {
	const channel = supabase.channel(channelName(sessionId));
	channel.subscribe();
	const allow = makeThrottle(RELAY_INTERVAL_MS);

	return {
		send(text: string, done = false) {
			if (!allow(done)) return;
			// Fire and forget: a relay that fails must never disturb the stream being
			// read on this phone, which is the copy that actually gets stored.
			try {
				void channel.send({ type: 'broadcast', event: EVENT, payload: { text, done } });
			} catch {
				/* the receiving phones fall back to polling */
			}
		},
		close() {
			try {
				void supabase.removeChannel(channel);
			} catch {
				/* nothing to do */
			}
		}
	};
}

/**
 * Listens on a receiving phone. `onText` is called with the paragraph so far.
 * Returns an unsubscribe function.
 */
export function subscribeToRecap(
	sessionId: string,
	onText: (text: string, done: boolean) => void
): () => void {
	const channel = supabase
		.channel(channelName(sessionId))
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		.on('broadcast', { event: EVENT }, ({ payload }: any) => {
			if (typeof payload?.text === 'string') onText(payload.text, !!payload?.done);
		})
		.subscribe();

	return () => {
		try {
			void supabase.removeChannel(channel);
		} catch {
			/* nothing to do */
		}
	};
}
