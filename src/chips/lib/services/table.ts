import { supabase } from '../supabase';
import type { Session, Player, BlindLevel, GameEventType } from '../types';

// Appends a row to the session's activity log (the ledger). Fire-and-forget from the
// caller's perspective — logging never blocks or fails the underlying game action.
// Amount conventions: blinds = blind size; bet/raise = raise-to total; call = chips
// added; win = pot slice; rebuy = chips added; others omit amount.
export async function logEvent(
	sessionId: string,
	type: GameEventType,
	opts: {
		playerId?: string | null;
		amount?: number | null;
		street?: string | null;
		targetPlayerId?: string | null;
	} = {}
): Promise<void> {
	await supabase.from('events').insert({
		session_id: sessionId,
		type,
		player_id: opts.playerId ?? null,
		amount: opts.amount ?? null,
		street: opts.street ?? null,
		target_player_id: opts.targetPlayerId ?? null
	});
}

export function nextButtonPlayerId(
	session: Session,
	eligiblePlayers: Player[],
	allPlayers: Player[] = eligiblePlayers
): string {
	// Rotate by seat_order, not array position. Callers pass the store's `players` array, which
	// is only seat-ordered at load time — after reorderSeats (or any realtime reshuffle) the array
	// order and seat_order diverge, and an array-position rotation would skip to the wrong seat.
	const sorted = [...eligiblePlayers].sort((a, b) => a.seat_order - b.seat_order);
	const currentIdx = sorted.findIndex((p) => p.id === session.button_player_id);
	if (currentIdx !== -1) return sorted[(currentIdx + 1) % sorted.length].id;
	// The button holder isn't eligible (busted, left, kicked) so they're missing from
	// eligiblePlayers. Rotate off their seat instead: look their seat up in allPlayers and
	// take the next eligible seat clockwise, wrapping — not seat 0, which would skip play
	// around the table.
	const buttonSeat =
		allPlayers.find((p) => p.id === session.button_player_id)?.seat_order ?? -Infinity;
	return (sorted.find((p) => p.seat_order > buttonSeat) ?? sorted[0]).id;
}

/**
 * Returns players in the order they act for a given betting street.
 *
 * Preflop: action starts left of the big blind (UTG).
 *   seat order: [BTN, SB, BB, UTG, ...] → action order: [UTG, ..., BTN, SB, BB]
 *
 * Postflop: action starts left of the button (SB).
 *   seat order: [BTN, SB, BB, UTG, ...] → action order: [SB, BB, UTG, ..., BTN]
 *
 * Heads-up follows the house rule (not the tournament convention): the dealer
 * posts the BB, the other player posts the SB and speaks first on every street.
 */
export function getActionOrder(
	session: Session,
	activePlayers: Player[],
	isPreflop: boolean
): Player[] {
	if (activePlayers.length === 0) return [];

	const sorted = [...activePlayers].sort((a, b) => a.seat_order - b.seat_order);
	const btnIdx = sorted.findIndex((p) => p.id === session.button_player_id);
	// If button player is not among actives, treat seat 0 as button.
	const effectiveBtnIdx = btnIdx === -1 ? 0 : btnIdx;
	const n = sorted.length;

	let startOffset: number;
	if (n <= 2) {
		// Heads-up house rule: the non-dealer (SB) acts first on every street.
		startOffset = (effectiveBtnIdx + 1) % n;
	} else {
		// 3+ players: preflop starts UTG (3 left of btn), postflop starts SB (1 left of btn).
		startOffset = isPreflop ? (effectiveBtnIdx + 3) % n : (effectiveBtnIdx + 1) % n;
	}

	return Array.from({ length: n }, (_, i) => sorted[(startOffset + i) % n]);
}

/**
 * The first player to act post-flop: the first non-folded player who still has chips,
 * walking clockwise from the button. Returns null when nobody can act (e.g. everyone
 * remaining is all-in).
 *
 * Built on `getActionOrder`, which locates the button among *all* active players (folded
 * included), so the button's seat position is preserved even when the button player has
 * folded. A naive "filter folded, then find the button" approach loses the button in that
 * case and starts action one seat too late.
 */
export function firstPostflopActor(session: Session, activePlayers: Player[]): Player | null {
	return (
		getActionOrder(session, activePlayers, false).find((p) => !p.folded && p.stack > 0) ?? null
	);
}

/**
 * Players who must act before `targetId` on the current street, in action order.
 *
 * Walks forward (in seat order, wrapping) from `session.current_actor_id`, collecting
 * every eligible player up to — but not including — the target. "Eligible" means active,
 * not folded, and holding chips (all-in players can't act, so they're skipped).
 *
 * Returns `[]` when the target is the current actor (it's already their turn), and `null`
 * when there is no current actor or the target isn't an eligible actor. The wrap handles
 * the normal "last to act post-flop" case where the target's seat is behind the actor's.
 */
export function playersBeforeTarget(
	session: Session,
	activePlayers: Player[],
	targetId: string
): Player[] | null {
	const eligible = activePlayers
		.filter((p) => p.is_active && !p.folded && p.stack > 0)
		.sort((a, b) => a.seat_order - b.seat_order);
	const startIdx = eligible.findIndex((p) => p.id === session.current_actor_id);
	if (startIdx === -1) return null; // no current actor among eligible players
	if (!eligible.some((p) => p.id === targetId)) return null; // target can't act
	if (session.current_actor_id === targetId) return []; // already the target's turn

	const before: Player[] = [];
	const n = eligible.length;
	for (let i = 0; i < n; i++) {
		const p = eligible[(startIdx + i) % n];
		if (p.id === targetId) return before;
		before.push(p);
	}
	return null; // unreachable: target is guaranteed present
}

/**
 * Decides how each intervening player is resolved when someone acts out of turn:
 * a player folds if they still owe chips to match the current bet, otherwise they check.
 * This makes "out-of-turn call ⇒ others fold" and "out-of-turn check ⇒ others check"
 * fall out automatically.
 */
export function interveningResolutions(
	before: Player[],
	currentBet: number
): { fold: string[]; check: string[] } {
	const fold: string[] = [];
	const check: string[] = [];
	for (const p of before) {
		if (p.current_round_bet < currentBet) fold.push(p.id);
		else check.push(p.id);
	}
	return { fold, check };
}

// A player is dealt into a hand only if they have chips to play with.
const hasChips = (p: Player) => p.stack > 0;
// Would the player still be broke after this hand's bets are refunded to them?
const bustedAfterRefund = (p: Player) => p.stack + p.hand_total_bet === 0;

export async function rotateButton(
	session: Session,
	eligiblePlayers: Player[],
	allPlayers: Player[] = eligiblePlayers
): Promise<void> {
	if (!eligiblePlayers.length) return;
	const nextId = nextButtonPlayerId(session, eligiblePlayers, allPlayers);
	await supabase.from('sessions').update({ button_player_id: nextId }).eq('id', session.id);
}

// Sets current_actor_id to the first preflop actor. Call once when a session becomes active
// and current_actor_id is still null. Idempotent — safe to call from multiple clients.
export async function initTurnOrder(session: Session, activePlayers: Player[]): Promise<void> {
	if (!activePlayers.length) return;
	const order = getActionOrder(session, activePlayers, true);
	if (!order.length) return;
	await supabase
		.from('sessions')
		.update({ current_actor_id: order[0].id })
		.eq('id', session.id)
		.is('current_actor_id', null);
}

// Advances current_actor_id to the next eligible player (active, not folded, not all-in) in seat order.
// The update is scoped to `session.street`: if another client has already ended this street and set
// the next street's first actor, this stale advance is a no-op and won't clobber that actor.
export async function advanceTurn(session: Session, activePlayers: Player[]): Promise<void> {
	const eligible = activePlayers.filter((p) => !p.folded && p.stack > 0);
	if (!eligible.length) return;
	const sorted = [...eligible].sort((a, b) => a.seat_order - b.seat_order);
	const currentActor = activePlayers.find((p) => p.id === session.current_actor_id);
	const currentSeatOrder = currentActor?.seat_order ?? -1;
	const afterCurrent = sorted.filter((p) => p.seat_order > currentSeatOrder);
	const next = afterCurrent.length > 0 ? afterCurrent[0] : sorted[0];
	await supabase
		.from('sessions')
		.update({ current_actor_id: next.id })
		.eq('id', session.id)
		.eq('street', session.street);
}

// Points the turn at `actorId`, scoped to the street it was decided on. If another client
// has already advanced the street (and set that street's first actor), this stale write is
// a no-op and won't clobber it — same guard as advanceTurn. Used by out-of-turn play, where
// the store resolves the players ahead of someone then claims the turn for them mid-street.
export async function setCurrentActor(
	sessionId: string,
	actorId: string,
	street: string
): Promise<void> {
	await supabase
		.from('sessions')
		.update({ current_actor_id: actorId })
		.eq('id', sessionId)
		.eq('street', street);
}

// Marks player as folded and advances the turn.
export async function foldHand(
	player: Player,
	session: Session,
	activePlayers: Player[]
): Promise<void> {
	await supabase
		.from('players')
		.update({ folded: true, acted_on_street: session.street })
		.eq('id', player.id);
	await logEvent(session.id, 'fold', { playerId: player.id, street: session.street });
	const withFolded = activePlayers.map((p) => (p.id === player.id ? { ...p, folded: true } : p));
	await advanceTurn(session, withFolded);
}

// Calls the current bet: deducts the outstanding amount and advances the turn.
//
// The chip arithmetic is computed from freshly read rows, never the caller's realtime
// cache. These are absolute writes, and the deal is written by the HOST's client — the
// caller only learns their own blind left their stack via a realtime echo. A dropped
// echo leaves the cache at the pre-blind stack with current_round_bet 0, so a call
// computed from it deducts the full current_bet from a stack the blind already left:
// the pot gains the whole call while the stack only drops the difference, minting
// exactly one blind of extra chips. (Seen live as the intermittent "table is 50 over"
// banner — the small blind is the usual victim, since the big blind mostly checks and
// a check never writes the stack.)
export async function callBet(
	session: Session,
	player: Player,
	activePlayers: Player[]
): Promise<void> {
	const [{ data: freshPlayer }, { data: freshSession }] = await Promise.all([
		supabase.from('players').select('*').eq('id', player.id).single(),
		supabase.from('sessions').select('*').eq('id', session.id).single()
	]);
	const p = (freshPlayer as Player | null) ?? player;
	const s = (freshSession as Session | null) ?? session;

	const owed = s.current_bet - p.current_round_bet;
	const callAmount = Math.min(owed, p.stack);
	if (callAmount <= 0) {
		await supabase.from('players').update({ acted_on_street: session.street }).eq('id', player.id);
		await logEvent(session.id, 'check', { playerId: player.id, street: session.street });
		await advanceTurn(session, activePlayers);
		return;
	}
	await Promise.all([
		supabase
			.from('players')
			.update({
				stack: p.stack - callAmount,
				current_round_bet: p.current_round_bet + callAmount,
				acted_on_street: session.street,
				hand_total_bet: p.hand_total_bet + callAmount
			})
			.eq('id', player.id),
		supabase
			.from('sessions')
			.update({ pot: s.pot + callAmount })
			.eq('id', session.id)
	]);
	await logEvent(session.id, 'call', {
		playerId: player.id,
		amount: callAmount,
		street: session.street
	});
	await advanceTurn(session, activePlayers);
}

// Returns true when all non-folded, non-all-in players have acted and matched the current bet.
// All-in players (stack === 0) cannot act further and are excluded from the requirement.
// If every remaining non-folded player is all-in, the street ends immediately.
//
// "Acted this street" is derived from acted_on_street === session.street rather than a boolean, so
// it is impossible for this to read a fresh street as over: a street advance flips session.street
// in a single write, which atomically makes every player's stale acted_on_street (the previous
// street) compare unequal. See the migration 20240108000000_acted_on_street.sql.
export function isStreetOver(session: Session, nonFoldedActivePlayers: Player[]): boolean {
	if (!nonFoldedActivePlayers.length) return false;
	// Guard against a stale realtime snapshot of a bet/raise still in flight: a bet writes the
	// bettor's player row, session.current_bet, and the other players' acted reset as separate rows
	// that arrive in arbitrary order. In any consistent state session.current_bet is the max of all
	// current_round_bet, so a player showing more than current_bet means the bet hasn't fully
	// propagated yet. Crucially, when that bet is all-in the bettor drops out of canAct below, so
	// without this check we'd judge the street on the opponents alone — who still match the stale
	// (pre-bet) current_bet — and skip to showdown before they answer the all-in.
	if (nonFoldedActivePlayers.some((p) => p.current_round_bet > session.current_bet)) return false;
	const canAct = nonFoldedActivePlayers.filter((p) => p.stack > 0);
	if (!canAct.length) return true;
	// Betting is closed when only one player still has chips and they've matched the
	// all-ins: nobody is left who could call anything further. This must precede the
	// "nobody acted yet" guard so an all-in run-out doesn't force the lone live player
	// to tap Check on every street.
	if (canAct.length === 1 && canAct[0].current_round_bet >= session.current_bet) return true;
	// If nobody has acted on this street yet, it just started and cannot be over. (Also covers the
	// realtime race where session.street has advanced but the per-player acted state is stale.)
	if (canAct.every((p) => p.acted_on_street !== session.street)) return false;
	return canAct.every(
		(p) => p.acted_on_street === session.street && p.current_round_bet === session.current_bet
	);
}

// True when the betting round is finished and the hand is still contested — i.e. the moment
// the table waits for the host/dealer to confirm dealing the next street. Showdown has no
// next street, and with fewer than two players left the hand ends by folds (fold-win flow),
// not by dealing.
export function streetReadyToAdvance(session: Session, activePlayers: Player[]): boolean {
	if (session.street === 'showdown') return false;
	const nonFolded = activePlayers.filter((p) => !p.folded);
	if (nonFolded.length < 2) return false;
	return isStreetOver(session, nonFolded);
}

// Label for the confirmation button that advances past `street`.
export function nextStreetLabel(street: string): string {
	switch (street) {
		case 'preflop':
			return 'Deal Flop';
		case 'flop':
			return 'Deal Turn';
		case 'turn':
			return 'Deal River';
		default:
			return 'Go to Showdown';
	}
}

// True when no further betting is possible this hand: at most one non-folded player
// still has chips (everyone else is all-in), so the remaining streets are a pure
// run-out. The hand jumps straight to showdown — the board gets dealt in real life
// either way, and per-street confirm taps are just noise.
export function isRunOut(activePlayers: Player[]): boolean {
	const nonFolded = activePlayers.filter((p) => !p.folded);
	if (nonFolded.length < 2) return false;
	return nonFolded.filter((p) => p.stack > 0).length <= 1;
}

const STREETS = ['preflop', 'flop', 'turn', 'river'] as const;

// Advances to the next street, resets bets, and sets the first postflop actor.
// Returns a display label for the new street (e.g. "Flop"), or "Showdown" after the river.
export async function advanceStreet(
	session: Session,
	activePlayers: Player[]
): Promise<string | null> {
	const currentIdx = STREETS.indexOf(session.street as (typeof STREETS)[number]);

	// Only current_round_bet is reset here; acted state is NOT touched. "Acted this street" is
	// acted_on_street === session.street, so flipping session.street below atomically invalidates
	// every player's acted status without a second, race-prone write.
	const playerReset = supabase
		.from('players')
		.update({ current_round_bet: 0 })
		.eq('session_id', session.id)
		.eq('is_active', true);

	if (currentIdx < 0 || currentIdx >= STREETS.length - 1 || isRunOut(activePlayers)) {
		// River completed — or an all-in run-out with nothing left to bet on any
		// street — showdown. Only advance if still on the expected street.
		const { data } = await supabase
			.from('sessions')
			.update({ street: 'showdown', current_bet: 0 })
			.eq('id', session.id)
			.eq('street', session.street)
			.select('id');
		if (!data?.length) return null; // Another client already advanced
		await playerReset;
		await logEvent(session.id, 'street', { street: 'showdown' });
		return 'Showdown';
	}

	const nextStreet = STREETS[currentIdx + 1];
	const firstActor = firstPostflopActor(session, activePlayers);

	const { data } = await supabase
		.from('sessions')
		.update({ street: nextStreet, current_bet: 0, current_actor_id: firstActor?.id ?? null })
		.eq('id', session.id)
		.eq('street', session.street)
		.select('id');
	if (!data?.length) return null; // Another client already advanced
	await playerReset;
	await logEvent(session.id, 'street', { street: nextStreet });

	return nextStreet.charAt(0).toUpperCase() + nextStreet.slice(1);
}

// Resets current_bet and all players' current_round_bet for the next street.
// Kept for backward compatibility; prefer advanceStreet for automated flow.
export async function newStreet(session: Session): Promise<void> {
	await Promise.all([
		supabase.from('sessions').update({ current_bet: 0 }).eq('id', session.id),
		supabase.from('players').update({ current_round_bet: 0 }).eq('session_id', session.id)
	]);
}

export async function endHand(
	session: Session,
	players: Player[],
	winnerPlayerId: string | null,
	handPotTotal: number
): Promise<void> {
	if (winnerPlayerId && handPotTotal > 0) {
		await supabase.from('hands').insert({
			session_id: session.id,
			pot_total: handPotTotal,
			winner_player_id: winnerPlayerId
		});
	}

	// Deal from committed truth, not the caller's snapshot. The award writes are
	// already committed when this runs, but the caller's `players` comes from the
	// realtime cache, which a delayed echo or an in-flight load() can have reverted
	// to pre-award values. postBlinds below writes SB/BB stacks as ABSOLUTE numbers,
	// so dealing from a stale snapshot erases a just-awarded pot (seen live: a
	// fold-win's 950 vanished because the winner posted the next big blind from a
	// stack that predated the award).
	const { data: freshRows } = await supabase
		.from('players')
		.select('*')
		.eq('session_id', session.id);
	const basePlayers = (freshRows as Player[] | null) ?? players;

	const activePlayers = basePlayers.filter((p) => p.is_active);
	if (!activePlayers.length) return;

	// Busted players (stack 0 after awards) are dealt out of the next hand: they start
	// folded — so they're skipped by turn order and street logic — and the button skips them.
	const withChips = activePlayers.filter(hasChips);
	const nextButtonId = withChips.length
		? nextButtonPlayerId(session, withChips, activePlayers)
		: nextButtonPlayerId(session, activePlayers);

	await Promise.all([
		supabase
			.from('sessions')
			.update({ button_player_id: nextButtonId, street: 'preflop', pot: 0, current_bet: 0 })
			.eq('id', session.id),
		supabase
			.from('players')
			.update({ folded: false, current_round_bet: 0, acted_on_street: null, hand_total_bet: 0 })
			.eq('session_id', session.id)
			.eq('is_active', true)
			.gt('stack', 0),
		// Everyone else — busted actives AND inactive rows (left / kicked / disconnected)
		// — is dealt out with their hand state fully cleared. Inactive rows MUST be
		// included: computePots sums hand_total_bet across every row it's given, so a
		// leaver's uncleared bet would re-enter the pot math at every later showdown,
		// paying their chips out again each hand.
		supabase
			.from('players')
			.update({ folded: true, current_round_bet: 0, acted_on_street: null, hand_total_bet: 0 })
			.eq('session_id', session.id)
			.or('is_active.eq.false,stack.eq.0')
	]);

	await logEvent(session.id, 'deal');

	const nextSession = { ...session, button_player_id: nextButtonId, pot: 0 };
	const freshPlayers = activePlayers.map((p) => ({
		...p,
		folded: !hasChips(p),
		current_round_bet: 0,
		acted_on_street: null,
		hand_total_bet: 0
	}));
	await postBlinds(nextSession, freshPlayers);
}

// Shared re-deal core: returns every chip each player put in this hand (hand_total_bet)
// to their stack, resets the hand state, points the button at `buttonId`, and re-posts
// blinds. Players left with zero chips after the refund start the new hand folded (dealt
// out). No hand record is written — there was no winner.
async function redealHand(
	session: Session,
	callerPlayers: Player[],
	buttonId: string | null
): Promise<void> {
	// Same stale-snapshot hazard as endHand: the refund below writes stacks as
	// absolute values (stack + hand_total_bet), so compute it from freshly read
	// rows rather than the caller's realtime cache.
	const { data: freshRows } = await supabase
		.from('players')
		.select('*')
		.eq('session_id', session.id);
	// Refund EVERY row, inactive ones included: someone who left mid-hand keeps
	// their hand_total_bet (their chips are in the voided pot), and leaving it
	// uncleared both scores their bet as a permanent leaderboard loss and feeds
	// computePots a phantom contribution at every later showdown. Only active
	// players are dealt into the next hand (postBlinds below).
	const allPlayers = (freshRows as Player[] | null) ?? callerPlayers;
	const activePlayers = allPlayers.filter((p) => p.is_active);
	if (!activePlayers.length) return;
	await Promise.all([
		...allPlayers.map((p) =>
			supabase
				.from('players')
				.update({
					stack: p.stack + p.hand_total_bet,
					folded: !p.is_active || bustedAfterRefund(p),
					current_round_bet: 0,
					acted_on_street: null,
					hand_total_bet: 0
				})
				.eq('id', p.id)
		),
		supabase
			.from('sessions')
			.update({ button_player_id: buttonId, street: 'preflop', pot: 0, current_bet: 0 })
			.eq('id', session.id)
	]);

	await logEvent(session.id, 'deal');

	const nextSession = { ...session, button_player_id: buttonId, pot: 0 };
	const freshPlayers = activePlayers.map((p) => ({
		...p,
		stack: p.stack + p.hand_total_bet,
		folded: bustedAfterRefund(p),
		current_round_bet: 0,
		acted_on_street: null,
		hand_total_bet: 0
	}));
	await postBlinds(nextSession, freshPlayers);
}

// Ends the current hand without awarding the pot and moves on: refund, rotate the button,
// deal the next hand. Used when the host advances with chips still unclaimed in the pot.
export async function voidHand(session: Session, players: Player[]): Promise<void> {
	const activePlayers = players.filter((p) => p.is_active);
	if (!activePlayers.length) return;

	const withChips = activePlayers.filter((p) => !bustedAfterRefund(p));
	const nextButtonId = withChips.length
		? nextButtonPlayerId(session, withChips, activePlayers)
		: nextButtonPlayerId(session, activePlayers);
	await redealHand(session, activePlayers, nextButtonId);
}

// Re-deals the current hand: refund all bets and start over with the SAME button.
// For misdeals and other real-life mistakes.
export async function resetHand(session: Session, players: Player[]): Promise<void> {
	await redealHand(
		session,
		players.filter((p) => p.is_active),
		session.button_player_id
	);
}

// Host override for a misplaced dealer button. Before the game starts it's a simple pointer
// move; mid-hand (the UI gates this to preflop, like reorderSeats) the hand is re-dealt
// against the new button so blinds and action order stay consistent.
export async function setDealer(
	session: Session,
	players: Player[],
	targetPlayerId: string
): Promise<void> {
	if (session.current_actor_id === null) {
		await supabase
			.from('sessions')
			.update({ button_player_id: targetPlayerId })
			.eq('id', session.id);
		return;
	}
	await redealHand(
		session,
		players.filter((p) => p.is_active),
		targetPlayerId
	);
}

// Awards a pot slice to a winner: increments their stack and decrements session.pot.
// The stack/pot bases are read fresh (see callBet — absolute writes from a stale cache
// mint or vanish chips); winnerStack/remainingPot are only fallbacks if the reads fail.
export async function awardPot(
	sessionId: string,
	winnerId: string,
	winnerStack: number,
	amount: number,
	remainingPot: number
): Promise<void> {
	const [{ data: freshWinner }, { data: freshSession }] = await Promise.all([
		supabase.from('players').select('stack').eq('id', winnerId).single(),
		supabase.from('sessions').select('pot').eq('id', sessionId).single()
	]);
	const stackBase = freshWinner?.stack ?? winnerStack;
	const potBase = freshSession?.pot ?? remainingPot;
	await Promise.all([
		supabase
			.from('players')
			.update({ stack: stackBase + amount })
			.eq('id', winnerId),
		supabase
			.from('sessions')
			.update({ pot: potBase - amount })
			.eq('id', sessionId)
	]);
	await logEvent(sessionId, 'win', { playerId: winnerId, amount });
}

// Awards one showdown round's payouts (see resolveAward): each winner's stack rises by
// their amount and session.pot drops by the round total. One 'win' ledger line per
// winner. Stack/pot bases are read fresh (see callBet — absolute writes from a stale
// cache mint or vanish chips); the caller's newStack/newPot are only fallbacks.
export async function awardPayouts(
	sessionId: string,
	payouts: { playerId: string; newStack: number; amount: number }[],
	newPot: number
): Promise<void> {
	const [{ data: freshRows }, { data: freshSession }] = await Promise.all([
		supabase.from('players').select('id, stack').eq('session_id', sessionId),
		supabase.from('sessions').select('pot').eq('id', sessionId).single()
	]);
	const stackById = new Map((freshRows ?? []).map((r) => [r.id as string, r.stack as number]));
	const total = payouts.reduce((sum, w) => sum + w.amount, 0);
	const potBase = freshSession?.pot;
	await Promise.all([
		...payouts.map((w) => {
			const base = stackById.get(w.playerId);
			const stack = base !== undefined ? base + w.amount : w.newStack;
			return supabase.from('players').update({ stack }).eq('id', w.playerId);
		}),
		supabase
			.from('sessions')
			.update({ pot: potBase !== undefined ? potBase - total : newPot })
			.eq('id', sessionId)
	]);
	for (const w of payouts) {
		await logEvent(sessionId, 'win', { playerId: w.playerId, amount: w.amount });
	}
}

export async function claimHost(myPlayer: Player, currentHost: Player | undefined): Promise<void> {
	if (currentHost) {
		// Compare-and-swap on the stale host. When several players see the host drop out and claim
		// at once, only one can flip the host's is_host true→false: Postgres row-locks that update,
		// so exactly one matches and the rest see zero rows. Only the winner goes on to take the
		// host flag, so a dropout can't leave two is_host rows (which would mean two award UIs and
		// concurrent awards minting chips). Done before taking the flag so the CAS gates it.
		const { data } = await supabase
			.from('players')
			.update({ is_host: false })
			.eq('id', currentHost.id)
			.eq('is_host', true)
			.select('id');
		if (!data?.length) return; // another client already claimed host
	}
	await supabase.from('players').update({ is_host: true }).eq('id', myPlayer.id);
}

export async function endSession(sessionId: string): Promise<void> {
	// Hand back anything still on the felt — blinds included — before the books close.
	// The leaderboard reads net as stack − buy-in, so chips abandoned in an unfinished
	// pot would score as permanent losses for whoever had bet them. Inactive players
	// are refunded too: someone who left mid-hand keeps their hand_total_bet, and their
	// net has to come out right as well.
	//
	// Read the rows fresh rather than trusting a caller snapshot: these are absolute
	// stack writes, and a stale realtime cache is exactly how chips have gone missing
	// before (see endHand).
	const { data: rows } = await supabase.from('players').select('*').eq('session_id', sessionId);
	const owed = ((rows as Player[] | null) ?? []).filter((p) => p.hand_total_bet > 0);
	if (owed.length) {
		await Promise.all(
			owed.map((p) =>
				supabase
					.from('players')
					.update({
						stack: p.stack + p.hand_total_bet,
						hand_total_bet: 0,
						current_round_bet: 0
					})
					.eq('id', p.id)
			)
		);
	}
	await supabase
		.from('sessions')
		.update({ status: 'ended', pot: 0, current_bet: 0 })
		.eq('id', sessionId);
}

export async function leaveTable(
	player: Player,
	session: Session,
	allPlayers: Player[]
): Promise<void> {
	await supabase.from('players').update({ is_active: false }).eq('id', player.id);
	await logEvent(session.id, 'leave', { playerId: player.id });

	// If the leaving player holds the button, rotate it to the next active player.
	if (session.button_player_id === player.id) {
		const remaining = allPlayers.filter((p) => p.is_active && p.id !== player.id);
		await rotateButton(session, remaining, allPlayers);
	}
}

// Posts blinds and sets the first preflop actor. Used by startGame, endHand, and reorderSeats.
// session.button_player_id must be the current (or new) button. session.pot must be 0.
// activePlayers must have current_round_bet at 0 and acted_on_street already cleared to null.
// Pass logBlinds=false to suppress ledger entries (reorderSeats re-posts blinds within an
// already-dealt hand, so it keeps the original blind log rather than duplicating it).
//
// The current_actor_id write below is intentionally NOT street-scoped (unlike advanceTurn /
// setCurrentActor). All callers are host-only, single-client operations that run at a fresh
// deal: the players were just reset (acted_on_street=null), so no client can confirm a street
// advance (isStreetOver's "nobody acted yet" guard returns false). There is no concurrent
// street transition in this window, so there is nothing to clobber.
export async function postBlinds(
	session: Session,
	activePlayers: Player[],
	logBlinds = true
): Promise<void> {
	// Busted players (no chips) are dealt out: they post no blinds, take no turn, and
	// don't shift the blind positions. Callers mark them folded at deal time.
	const playersIn = activePlayers.filter(hasChips);
	if (playersIn.length < 2) return;

	const sorted = [...playersIn].sort((a, b) => a.seat_order - b.seat_order);
	const n = sorted.length;
	const btnIdx = sorted.findIndex((p) => p.id === session.button_player_id);
	const effectiveBtnIdx = btnIdx === -1 ? 0 : btnIdx;

	// SB sits left of the button at any table size. Heads-up (house rule) the +2
	// offset wraps back onto the dealer, who posts the BB.
	const sbPlayer = sorted[(effectiveBtnIdx + 1) % n];
	const bbPlayer = sorted[(effectiveBtnIdx + 2) % n];

	const sbAmount = Math.min(session.small_blind, sbPlayer.stack);
	const bbAmount = Math.min(session.big_blind, bbPlayer.stack);

	const order = getActionOrder(session, playersIn, true);
	const firstActorId = order[0]?.id ?? null;

	await Promise.all([
		supabase
			.from('players')
			.update({
				stack: sbPlayer.stack - sbAmount,
				current_round_bet: sbAmount,
				hand_total_bet: sbPlayer.hand_total_bet + sbAmount
			})
			.eq('id', sbPlayer.id),
		supabase
			.from('players')
			.update({
				stack: bbPlayer.stack - bbAmount,
				current_round_bet: bbAmount,
				hand_total_bet: bbPlayer.hand_total_bet + bbAmount
			})
			.eq('id', bbPlayer.id),
		supabase
			.from('sessions')
			.update({
				pot: session.pot + sbAmount + bbAmount,
				current_bet: bbAmount,
				current_actor_id: firstActorId
			})
			.eq('id', session.id)
	]);

	if (logBlinds) {
		await logEvent(session.id, 'post_sb', { playerId: sbPlayer.id, amount: sbAmount });
		await logEvent(session.id, 'post_bb', { playerId: bbPlayer.id, amount: bbAmount });
	}
}

export async function startGame(session: Session, activePlayers: Player[]): Promise<void> {
	await logEvent(session.id, 'deal');
	await postBlinds(session, activePlayers);
}

// Cash games with an escalation schedule climb one rung of the doubling ladder
// after any hand that eliminated somebody. Tournament levels advance on the timer.
// The current_actor_id check means "a hand has been dealt": sessions are status
// 'active' from setup, so without it a lobby kick (before any cards) raised blinds.
export function cashEscalationActive(session: Session): boolean {
	return (
		session.status === 'active' &&
		session.current_actor_id !== null &&
		session.game_mode === 'cash' &&
		(session.blind_schedule?.length ?? 0) > 0 &&
		// Host turned automatic escalation off at setup; the schedule still exists so
		// they can move the blinds by hand. Undefined means the column predates the
		// migration — treat that as on, matching the old behaviour.
		session.auto_escalate !== false
	);
}

// Host override from the blind schedule sheet: jump to `levelIdx` in either
// direction. Takes effect when blinds are next posted — the next deal, or this
// hand if the host follows up with Reset hand (which re-posts blinds).
export async function setBlindLevel(session: Session, levelIdx: number): Promise<void> {
	const level = session.blind_schedule?.[levelIdx];
	if (!level) return;
	await supabase
		.from('sessions')
		.update({
			blind_level: levelIdx,
			small_blind: level.small_blind,
			big_blind: level.big_blind
		})
		.eq('id', session.id);
}

export async function advanceBlindLevel(session: Session): Promise<void> {
	const schedule = session.blind_schedule;
	if (!schedule?.length) return;

	const currentLevel = session.blind_level ?? 0;
	const nextLevelIdx = currentLevel + 1;
	if (nextLevelIdx >= schedule.length) return;

	const next: BlindLevel = schedule[nextLevelIdx];
	const isLastLevel = nextLevelIdx === schedule.length - 1;
	const isTournament = session.game_mode === 'tournament';

	await supabase
		.from('sessions')
		.update({
			blind_level: nextLevelIdx,
			small_blind: next.small_blind,
			big_blind: next.big_blind,
			blind_level_started_at: isTournament && !isLastLevel ? new Date().toISOString() : null
		})
		.eq('id', session.id)
		.eq('blind_level', currentLevel);
}

export async function kickPlayer(
	targetPlayer: Player,
	session: Session,
	allPlayers: Player[]
): Promise<void> {
	const activePlayers = allPlayers.filter((p) => p.is_active);

	// Auto-fold if mid-hand and not already folded, so the hand can continue cleanly.
	if (session.current_actor_id && !targetPlayer.folded) {
		await foldHand(targetPlayer, session, activePlayers);
	}

	await supabase.from('players').update({ is_active: false }).eq('id', targetPlayer.id);
	await logEvent(session.id, 'kick', { playerId: targetPlayer.id });

	if (session.button_player_id === targetPlayer.id) {
		const remaining = allPlayers.filter((p) => p.is_active && p.id !== targetPlayer.id);
		await rotateButton(session, remaining, allPlayers);
	}
}

// Reorders active player seats. If the game is in progress (preflop), returns all chips bet
// this hand and re-posts blinds relative to the new seat order. The button player is unchanged.
export async function reorderSeats(
	session: Session,
	activePlayers: Player[],
	newOrder: Player[]
): Promise<void> {
	// Assign new seat_order values (0, 1, 2, ...) to active players in desired order
	await Promise.all(
		newOrder.map((p, i) => supabase.from('players').update({ seat_order: i }).eq('id', p.id))
	);

	// Pre-game (no actor yet): seat update is all that's needed
	if (session.current_actor_id === null) return;

	// Preflop in progress: return every chip bet this hand, reset session, then re-post blinds.
	// This current_actor_id reset is intentionally NOT street-scoped: reorderSeats is host-only
	// and preflop-only (UI gates it on is_host && street === 'preflop'), so it runs outside the
	// concurrent street-transition window that the advanceTurn / setCurrentActor guards protect.
	//
	// The refund is computed from freshly read rows, not the host's realtime cache — these
	// are absolute stack writes, the class of write that has minted/vanished chips before
	// (see callBet / endHand).
	const { data: freshRows } = await supabase
		.from('players')
		.select('*')
		.eq('session_id', session.id);
	if (freshRows?.length) {
		const freshById = new Map((freshRows as Player[]).map((p) => [p.id, p]));
		activePlayers = activePlayers.map((p) => freshById.get(p.id) ?? p);
	}

	await Promise.all([
		...activePlayers.map((p) =>
			supabase
				.from('players')
				.update({
					stack: p.stack + p.hand_total_bet,
					current_round_bet: 0,
					acted_on_street: null,
					hand_total_bet: 0,
					folded: bustedAfterRefund(p)
				})
				.eq('id', p.id)
		),
		supabase
			.from('sessions')
			.update({ pot: 0, current_bet: 0, current_actor_id: null })
			.eq('id', session.id)
	]);

	const stackById = new Map(activePlayers.map((p) => [p.id, p.stack + p.hand_total_bet]));
	const freshPlayers = newOrder.map((p, i) => ({
		...p,
		seat_order: i,
		stack: stackById.get(p.id) ?? p.stack,
		current_round_bet: 0,
		acted_on_street: null as string | null,
		hand_total_bet: 0,
		folded: bustedAfterRefund(p)
	}));
	await postBlinds({ ...session, pot: 0, current_bet: 0 }, freshPlayers, false);
}

// Host correction for a chip-conservation mismatch: credits (or debits) a player's
// stack without touching total_buyin, restoring sum(stacks) + pot == sum(buy-ins).
// Logged as an 'adjust' event so the fix is visible in the ledger.
export async function adjustChips(
	sessionId: string,
	player: Player,
	amount: number
): Promise<void> {
	if (!Number.isInteger(amount) || amount === 0) return;
	await supabase
		.from('players')
		.update({ stack: player.stack + amount })
		.eq('id', player.id);
	await logEvent(sessionId, 'adjust', { playerId: player.id, amount });
}

// Transfers chips from one player's stack to another's — the app equivalent of handing
// chips across the table. Only behind-the-line stacks move; bets already in the pot
// (current_round_bet / hand_total_bet) are untouched, so pot math is unaffected. Nets
// shift accordingly (net = stack − buy-in): the giver goes down, the receiver up.
export async function giveChips(giver: Player, recipient: Player, amount: number): Promise<void> {
	if (!Number.isInteger(amount) || amount <= 0 || amount > giver.stack) return;
	if (!recipient.is_active || recipient.id === giver.id) return;
	await Promise.all([
		supabase
			.from('players')
			.update({ stack: giver.stack - amount })
			.eq('id', giver.id),
		supabase
			.from('players')
			.update({ stack: recipient.stack + amount })
			.eq('id', recipient.id)
	]);
	await logEvent(giver.session_id, 'give', {
		playerId: giver.id,
		amount,
		targetPlayerId: recipient.id
	});
}

export async function doRebuy(player: Player, amount: number): Promise<void> {
	await Promise.all([
		supabase
			.from('players')
			.update({
				stack: player.stack + amount,
				total_buyin: player.total_buyin + amount
			})
			.eq('id', player.id),
		supabase.from('rebuys').insert({
			session_id: player.session_id,
			player_id: player.id,
			amount
		})
	]);
	await logEvent(player.session_id, 'rebuy', { playerId: player.id, amount });
}
