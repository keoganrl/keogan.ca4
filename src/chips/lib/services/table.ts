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
 * With fewer than 3 players the standard heads-up convention applies:
 *   BTN posts SB and acts first preflop; BB acts first postflop.
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
		// Heads-up: BTN/SB acts first preflop, BB acts first postflop.
		startOffset = isPreflop ? effectiveBtnIdx : (effectiveBtnIdx + 1) % n;
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
export async function callBet(
	session: Session,
	player: Player,
	activePlayers: Player[]
): Promise<void> {
	const owed = session.current_bet - player.current_round_bet;
	const callAmount = Math.min(owed, player.stack);
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
				stack: player.stack - callAmount,
				current_round_bet: player.current_round_bet + callAmount,
				acted_on_street: session.street,
				hand_total_bet: player.hand_total_bet + callAmount
			})
			.eq('id', player.id),
		supabase
			.from('sessions')
			.update({ pot: session.pot + callAmount })
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

	if (currentIdx < 0 || currentIdx >= STREETS.length - 1) {
		// River completed — showdown. Only advance if still on the expected street.
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

	const activePlayers = players.filter((p) => p.is_active);
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
		supabase
			.from('players')
			.update({ folded: true, current_round_bet: 0, acted_on_street: null, hand_total_bet: 0 })
			.eq('session_id', session.id)
			.eq('is_active', true)
			.eq('stack', 0)
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
	activePlayers: Player[],
	buttonId: string | null
): Promise<void> {
	if (!activePlayers.length) return;
	await Promise.all([
		...activePlayers.map((p) =>
			supabase
				.from('players')
				.update({
					stack: p.stack + p.hand_total_bet,
					folded: bustedAfterRefund(p),
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
export async function awardPot(
	sessionId: string,
	winnerId: string,
	winnerStack: number,
	amount: number,
	remainingPot: number
): Promise<void> {
	await Promise.all([
		supabase
			.from('players')
			.update({ stack: winnerStack + amount })
			.eq('id', winnerId),
		supabase
			.from('sessions')
			.update({ pot: remainingPot - amount })
			.eq('id', sessionId)
	]);
	await logEvent(sessionId, 'win', { playerId: winnerId, amount });
}

// Awards one showdown round's payouts (see resolveAward): each winner's stack is set to
// its post-award value and session.pot drops by the round total. One 'win' ledger line
// per winner. newStack values must already include the payout — the caller computed them
// from its optimistic state.
export async function awardPayouts(
	sessionId: string,
	payouts: { playerId: string; newStack: number; amount: number }[],
	newPot: number
): Promise<void> {
	await Promise.all([
		...payouts.map((w) =>
			supabase.from('players').update({ stack: w.newStack }).eq('id', w.playerId)
		),
		supabase.from('sessions').update({ pot: newPot }).eq('id', sessionId)
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
	await supabase.from('sessions').update({ status: 'ended' }).eq('id', sessionId);
}

export async function leaveTable(
	player: Player,
	session: Session,
	allPlayers: Player[]
): Promise<void> {
	await supabase.from('players').update({ is_active: false }).eq('id', player.id);
	await logEvent(session.id, 'leave', { playerId: player.id });

	// A seat with chips has emptied — climb the escalation ladder one rung. Busted
	// players (no chips in play) already advanced the blinds when they busted.
	if (cashEscalationActive(session) && player.stack + player.hand_total_bet > 0) {
		await advanceBlindLevels(session, 1);
	}

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

	const sbOffset = n <= 2 ? 0 : 1; // heads-up: BTN=SB; 3+: left of BTN=SB
	const sbPlayer = sorted[(effectiveBtnIdx + sbOffset) % n];
	const bbPlayer = sorted[(effectiveBtnIdx + sbOffset + 1) % n];

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

// Cash games with an escalation schedule climb the blinds automatically as seats
// empty (busts and departures). Tournament levels advance on the timer instead.
export function cashEscalationActive(session: Session): boolean {
	return (
		session.status === 'active' &&
		session.game_mode === 'cash' &&
		(session.blind_schedule?.length ?? 0) > 0
	);
}

// Advances `count` levels (one per emptied seat). Each step is CAS-guarded on
// blind_level by advanceBlindLevel, so a double-fire can't skip ahead.
export async function advanceBlindLevels(session: Session, count: number): Promise<void> {
	let current = session;
	for (let i = 0; i < count; i++) {
		const nextIdx = (current.blind_level ?? 0) + 1;
		if (nextIdx >= (current.blind_schedule?.length ?? 0)) return;
		await advanceBlindLevel(current);
		const next = current.blind_schedule[nextIdx];
		current = {
			...current,
			blind_level: nextIdx,
			small_blind: next.small_blind,
			big_blind: next.big_blind
		};
	}
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

	// Same seat-emptied escalation as leaveTable (folding above doesn't touch the stack).
	if (cashEscalationActive(session) && targetPlayer.stack + targetPlayer.hand_total_bet > 0) {
		await advanceBlindLevels(session, 1);
	}

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
