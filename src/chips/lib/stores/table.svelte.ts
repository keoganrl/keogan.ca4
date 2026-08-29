import { supabase } from '../supabase';
import {
	endHand as endHandService,
	voidHand as voidHandService,
	resetHand as resetHandService,
	setDealer as setDealerService,
	awardPot as awardPotService,
	awardPayouts as awardPayoutsService,
	claimHost as claimHostService,
	endSession as endSessionService,
	doRebuy as doRebuyService,
	giveChips as giveChipsService,
	adjustChips as adjustChipsService,
	kickPlayer as kickPlayerService,
	leaveTable as leaveTableService,
	advanceTurn as advanceTurnService,
	setCurrentActor as setCurrentActorService,
	foldHand as foldHandService,
	callBet as callBetService,
	streetReadyToAdvance,
	nextStreetLabel,
	isRunOut,
	advanceStreet as advanceStreetService,
	startGame as startGameService,
	advanceBlindLevel as advanceBlindLevelService,
	setBlindLevel as setBlindLevelService,
	cashEscalationActive,
	reorderSeats as reorderSeatsService,
	playersBeforeTarget,
	interveningResolutions,
	logEvent
} from '../services/table';
import type { Session, Player, GameEvent } from '../types';
import { formatBlindTime } from '../utils/blindSchedule';
import { computePots, resolveAward } from '../utils/pots';
import { facingShortAllIn, minRaiseTotal } from '../utils/betting';

export function createTableStore(sessionId: string, identityId: string) {
	let session = $state<Session | null>(null);
	// The name of the series this session counts towards, or '' for a one-off.
	//
	// Resolved once and kept beside the session rather than embedded in the session
	// select. `session` is replaced wholesale by realtime postgres_changes payloads,
	// and those carry only the row's own columns — an embedded series(name) would
	// survive the initial load and then vanish the first time anything on the table
	// changed. The name cannot change, so fetching it once is also simply correct.
	let seriesName = $state('');
	let players = $state<Player[]>([]);
	let events = $state<GameEvent[]>([]);
	let loading = $state(true);
	let now = $state(Date.now());

	// Winner of the main pot (first award) and original pot total, for hand record.
	let firstPotWinnerId: string | null = null;
	let handPotTotal = 0;

	const me = $derived(players.find((p) => p.identity_id === identityId) ?? null);

	const currentActor = $derived(
		session?.current_actor_id
			? (players.find((p) => p.id === session!.current_actor_id) ?? null)
			: null
	);

	const isMyTurn = $derived(!!me && !!session && session.current_actor_id === me.id);

	// Players who would have to check/fold before `me` could act out of turn, in action
	// order. Empty when it's already my turn; null when out-of-turn play isn't possible.
	const playersBeforeMe = $derived.by(() => {
		if (!me || !session || !session.current_actor_id) return null;
		return playersBeforeTarget(
			session,
			players.filter((p) => p.is_active),
			me.id
		);
	});

	const staleHost = $derived.by(() => {
		if (!players.length) return false;
		const host = players.find((p) => p.is_host);
		if (!host || host.identity_id === identityId) return false;
		const last = Date.parse(host.last_heartbeat_at);
		return now - last > 30000;
	});

	const ended = $derived(session?.status === 'ended');

	const hasBlindSchedule = $derived((session?.blind_schedule?.length ?? 0) > 0);

	const blindTimeRemaining = $derived.by((): number | null => {
		if (!session?.blind_level_started_at || !hasBlindSchedule) return null;
		const schedule = session.blind_schedule;
		const idx = session.blind_level ?? 0;
		if (idx >= schedule.length) return null;
		const level = schedule[idx];
		if (!level.duration_minutes) return null;
		const startedAt = Date.parse(session.blind_level_started_at);
		const durationMs = level.duration_minutes * 60 * 1000;
		return Math.max(0, Math.floor((startedAt + durationMs - now) / 1000));
	});

	const blindTimeDisplay = $derived(
		blindTimeRemaining !== null ? formatBlindTime(blindTimeRemaining) : null
	);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let channel: any = null;
	let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	let clockInterval: ReturnType<typeof setInterval> | null = null;

	// Guard against advancing the same level twice
	let lastAutoAdvancedLevel = -1;

	async function load() {
		// load() also runs on every resubscribe and tab-visibility change. Session and players
		// are small full fetches, but events is append-only and grows all session — only pull
		// rows newer than the highest seq we already hold (events stays sorted by seq).
		const sinceSeq = events.length ? events[events.length - 1].seq : -1;
		const [{ data: sessionData }, { data: playersData }, { data: eventsData }] = await Promise.all([
			supabase.from('sessions').select('*').eq('id', sessionId).single(),
			supabase.from('players').select('*').eq('session_id', sessionId).order('seat_order'),
			supabase
				.from('events')
				.select('*')
				.eq('session_id', sessionId)
				.gt('seq', sinceSeq)
				.order('seq')
		]);
		if (sessionData) session = sessionData as Session;
		// Only worth asking once, and only when there is something to ask about.
		if (session?.series_id && !seriesName) {
			supabase
				.from('series')
				.select('name')
				.eq('id', session.series_id)
				.maybeSingle()
				.then(({ data }) => {
					if (data?.name) seriesName = data.name;
				});
		}
		if (playersData) players = playersData as Player[];
		if (eventsData?.length) {
			// A realtime insert may have landed while this fetch was in flight — dedupe by id.
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient local, not state
			const known = new Set(events.map((e) => e.id));
			const fresh = (eventsData as GameEvent[]).filter((e) => !known.has(e.id));
			if (fresh.length) events = [...events, ...fresh].sort((a, b) => a.seq - b.seq);
		}
		loading = false;
		void maybeSkipMyTurn();
	}

	function subscribeToUpdates() {
		channel = supabase
			.channel(`table:${sessionId}`)
			.on(
				'postgres_changes',
				{ event: '*', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(payload: any) => {
					session = payload.new as Session;
					void maybeSkipMyTurn();
				}
			)
			.on(
				'postgres_changes',
				{ event: '*', schema: 'public', table: 'players', filter: `session_id=eq.${sessionId}` },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(payload: any) => {
					if (payload.eventType === 'INSERT') {
						const inserted = payload.new as Player;
						if (players.some((p) => p.id === inserted.id)) return;
						players = [...players, inserted];
					} else if (payload.eventType === 'UPDATE') {
						const updated = payload.new as Player;
						players = players.map((p) => (p.id === updated.id ? updated : p));
						void maybeSkipMyTurn();
					} else if (payload.eventType === 'DELETE') {
						players = players.filter((p) => p.id !== payload.old.id);
					}
				}
			)
			.on(
				'postgres_changes',
				{
					event: 'INSERT',
					schema: 'public',
					table: 'events',
					filter: `session_id=eq.${sessionId}`
				},
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(payload: any) => {
					const inserted = payload.new as GameEvent;
					if (events.some((e) => e.id === inserted.id)) return;
					// Keep ordered by seq; realtime delivery order isn't strictly guaranteed.
					events = [...events, inserted].sort((a, b) => a.seq - b.seq);
				}
			)
			// Refetch on every (re)subscribe: rows inserted before the channel went live, or
			// while the websocket was down (locked phone, network blip), never arrive as
			// events — this is why new joiners/kicks sometimes only showed up after a manual
			// refresh. supabase-js re-fires SUBSCRIBED after each successful rejoin.
			.subscribe((status: string) => {
				if (status === 'SUBSCRIBED') void load();
			});
	}

	// Returning to the tab after the phone was locked: the websocket may have silently
	// dropped events, so pull fresh state rather than trusting the last snapshot.
	function handleVisibilityChange() {
		if (document.visibilityState === 'visible') void load();
	}

	function startHeartbeat() {
		heartbeatInterval = setInterval(async () => {
			if (!me) return;
			await supabase
				.from('players')
				// eslint-disable-next-line svelte/prefer-svelte-reactivity
				.update({ last_heartbeat_at: new Date().toISOString() })
				.eq('id', me.id);
		}, 10000);
	}

	// Chip conservation: every chip on the table was bought in, so at any settled
	// moment sum(stacks) + pot === sum(total buy-ins) — rebuys raise both sides,
	// gives/awards/blinds/merges all move chips without minting them. A persistent
	// non-zero difference means a write was lost (chips silently vanished or
	// duplicated); positive = table short.
	const chipImbalance = $derived.by(() => {
		if (!session || !players.length) return 0;
		const buyins = players.reduce((sum, p) => sum + p.total_buyin, 0);
		const stacks = players.reduce((sum, p) => sum + p.stack, 0);
		return buyins - stacks - (session.pot ?? 0);
	});

	// Mid-action states legitimately break the invariant for a beat (a call writes
	// the player row and the pot as separate updates), so only a mismatch that holds
	// steady for several seconds is surfaced.
	let confirmedImbalance = $state(0);
	let imbalanceTicks = 0;
	let lastImbalance = 0;

	function startClock() {
		clockInterval = setInterval(() => {
			now = Date.now();

			const imbalance = actionPending ? 0 : chipImbalance;
			imbalanceTicks = imbalance !== 0 && imbalance === lastImbalance ? imbalanceTicks + 1 : 0;
			lastImbalance = imbalance;
			confirmedImbalance = imbalanceTicks >= 5 ? imbalance : 0;

			const level = session?.blind_level ?? -1;
			if (
				blindTimeRemaining !== null &&
				blindTimeRemaining <= 0 &&
				me?.is_host &&
				session?.game_mode === 'tournament' &&
				level !== lastAutoAdvancedLevel
			) {
				lastAutoAdvancedLevel = level;
				void advanceBlindLevelService(session!);
			}
		}, 1000);
	}

	async function init() {
		await load();
		subscribeToUpdates();
		startHeartbeat();
		startClock();
		document.addEventListener('visibilitychange', handleVisibilityChange);
		// Seed now so staleHost detection works before first heartbeat tick
		now = Date.now();
	}

	function destroy() {
		if (channel) supabase.removeChannel(channel);
		if (heartbeatInterval) clearInterval(heartbeatInterval);
		if (clockInterval) clearInterval(clockInterval);
		document.removeEventListener('visibilitychange', handleVisibilityChange);
	}

	// Computed once the street is showdown. computePots only reads hand_total_bet,
	// folded, and is_active — none of which change while pots are awarded — so this
	// stays stable throughout the award flow.
	const pots = $derived.by(() => {
		if (session?.street !== 'showdown') return [];
		return computePots(players);
	});

	// Winner sets the host has confirmed this showdown, in order ("who had the best
	// hand?" rounds). remainingPots is derived by replaying them over the stable pot
	// structure, so it survives re-renders; only this client (the host) mutates it.
	let awardRounds = $state<string[][]>([]);

	const remainingPots = $derived.by(() => {
		let rem = pots;
		for (const round of awardRounds) {
			rem = resolveAward(rem, round, players, session?.button_player_id ?? null).remainingPots;
		}
		return rem;
	});

	function resetAwards() {
		awardRounds = [];
	}

	// Awards one confirmed best-hand answer: the winner(s) take every remaining pot
	// they're eligible for (ties split — see resolveAward). Deeper side pots that
	// none of them could reach stay in remainingPots for the next question.
	async function awardBestHand(winnerIds: string[]) {
		if (!session || session.street !== 'showdown' || !winnerIds.length) return;
		const { payouts } = resolveAward(
			remainingPots,
			winnerIds,
			players,
			session.button_player_id ?? null
		);
		const entries = Object.entries(payouts);
		const total = entries.reduce((sum, [, amt]) => sum + amt, 0);
		if (total <= 0) return;

		if (!firstPotWinnerId) {
			firstPotWinnerId = winnerIds[0];
			handPotTotal = session.pot;
		}

		const newPot = session.pot - total;
		players = players.map((p) =>
			payouts[p.id] ? { ...p, stack: p.stack + payouts[p.id] } : p
		);
		session = { ...session, pot: newPot };
		awardRounds = [...awardRounds, winnerIds];

		await awardPayoutsService(
			sessionId,
			entries.map(([playerId, amount]) => ({
				playerId,
				amount,
				// players was just updated optimistically, so this stack already includes the payout
				newStack: players.find((p) => p.id === playerId)!.stack
			})),
			newPot
		);
	}

	// A client acting on a stale snapshot can advanceTurn onto a player who has already
	// folded (or is all-in and can't act). The mis-targeted player's own client is the one
	// place that reliably knows better, so it advances the turn past itself — exactly one
	// writer, no race. Checked after load() and after every realtime update.
	let skippingTurn = false;
	async function maybeSkipMyTurn() {
		if (skippingTurn || !me || !session) return;
		if (session.current_actor_id !== me.id) return;
		if (session.street === 'showdown') return;
		if (!me.folded && me.stack > 0) return;
		skippingTurn = true;
		try {
			await advanceTurnService(
				session,
				players.filter((p) => p.is_active)
			);
		} finally {
			skippingTurn = false;
		}
	}

	// Serialises player actions: a tap while the previous action is still writing is dropped.
	// (Playtest bug: a laggy "Confirm Raise" posted a duplicate bet on every extra tap.)
	let actionPending = $state(false);
	async function runExclusive<T>(fn: () => Promise<T>, whileBusy: T): Promise<T> {
		if (actionPending) return whileBusy;
		actionPending = true;
		try {
			return await fn();
		} finally {
			actionPending = false;
		}
	}

	// Betting round finished — the table waits for the host or dealer to confirm the next
	// street (the cards have to be dealt in real life first). Derived on every client from
	// the same realtime state, so everyone sees the frozen table at once.
	const streetComplete = $derived.by(() => {
		if (!session) return false;
		return streetReadyToAdvance(
			session,
			players.filter((p) => p.is_active)
		);
	});

	// Only the host or the dealer (button player) may confirm the street advance.
	const canConfirmNextStreet = $derived(
		streetComplete && !!me && !!session && (me.is_host || me.id === session.button_player_id)
	);

	// All-in run-out: no betting left on any street, so the one confirm jumps straight
	// to showdown (advanceStreet applies the same check server-side).
	const runOut = $derived(isRunOut(players.filter((p) => p.is_active)));

	const nextStreetAction = $derived(
		streetComplete && session
			? runOut
				? 'Go to Showdown'
				: nextStreetLabel(session.street)
			: null
	);

	// Raising is pointless when every other player still in the hand is already all-in:
	// nobody is left who could call more chips. It is also impossible when matching the
	// current bet already costs my whole stack — calling is then an all-in for less, not
	// a raise. Either way the UI collapses to call/fold.
	const canRaise = $derived.by(() => {
		if (!me || !session) return false;
		if (me.stack <= session.current_bet - me.current_round_bet) return false;
		// An all-in for less than a full raise doesn't reopen the betting: having already
		// acted this street, my only answers are calling the extra or folding.
		if (me.acted_on_street === session.street && facingShortAllIn(events, session)) return false;
		return players.some((p) => p.is_active && !p.folded && p.id !== me!.id && p.stack > 0);
	});

	// Fewest chips `me` must add for a legal raise (or opening bet), capped at their
	// stack — when the full min-raise is unaffordable, all-in is the only raise. The
	// UI floors its slider and default here so illegal raises can't be dialled in.
	const minRaiseAdd = $derived.by(() => {
		if (!me || !session) return 0;
		return Math.min(minRaiseTotal(session) - me.current_round_bet, me.stack);
	});

	async function confirmNextStreet() {
		if (!session || !streetComplete) return;
		// advanceStreet is street-scoped (CAS on session.street), so a double confirm —
		// host and dealer tapping at the same time — applies exactly once.
		// `players` carries the inactive rows too, which is how a dead button — somebody
		// left mid-hand holding it — keeps its seat when the first postflop actor is picked.
		await advanceStreetService(
			session,
			players.filter((p) => p.is_active),
			players
		);
	}

	// Resolves the players ahead of `me` so action reaches me, then points the turn at me.
	// Each intervening player folds if they still owe chips, otherwise checks. Setting
	// current_actor_id to me makes the subsequent advanceTurn advance from my seat. The actor
	// write is street-scoped (setCurrentActor) so that if a concurrent street transition has
	// already set the new street's first actor, this mid-street claim can't clobber it.
	async function resolveInterveningBeforeMe() {
		if (!me || !session) return;
		const before = playersBeforeMe;
		if (!before || !before.length) return;
		const currentBet = session.current_bet;
		const street = session.street;
		const { fold, check } = interveningResolutions(before, currentBet);

		players = players.map((p) => {
			if (fold.includes(p.id)) return { ...p, folded: true, acted_on_street: street };
			if (check.includes(p.id)) return { ...p, acted_on_street: street };
			return p;
		});
		session = { ...session, current_actor_id: me.id };

		await Promise.all([
			fold.length
				? supabase.from('players').update({ folded: true, acted_on_street: street }).in('id', fold)
				: Promise.resolve(),
			check.length
				? supabase.from('players').update({ acted_on_street: street }).in('id', check)
				: Promise.resolve(),
			setCurrentActorService(sessionId, me.id, street)
		]);

		// Log each auto-resolved player in action order (before me acts).
		for (const p of before) {
			await logEvent(sessionId, fold.includes(p.id) ? 'fold' : 'check', {
				playerId: p.id,
				street
			});
		}
	}

	async function placeBet(amount: number, outOfTurn = false): Promise<string> {
		if (!me || !session) return 'Not ready';
		if (amount <= 0) return 'Enter a bet amount.';
		if (amount > me.stack) return "You don't have enough chips.";

		// A raise must bring the round total to at least the minimum (double the
		// current bet). Below that isn't a raise — it wouldn't even match the bet, as
		// with 25 tossed over a 100 bet. Moving all-in for less is the one exception.
		const minTotal = minRaiseTotal(session);
		const isAllIn = amount === me.stack;
		if (me.current_round_bet + amount < minTotal && !isAllIn) {
			return session.current_bet > 0
				? `Raise to at least ${minTotal}.`
				: `Bet at least ${minTotal}.`;
		}

		// The betting was closed to me by an all-in too small to reopen it (canRaise hides
		// the panel for this, but the panel can already be open when the all-in lands).
		if (me.acted_on_street === session.street && facingShortAllIn(events, session)) {
			return 'That all-in was too small to reopen the betting — call or fold.';
		}

		if (outOfTurn) await resolveInterveningBeforeMe();
		if (!me || !session) return 'Not ready';

		// The chip arithmetic below is a set of ABSOLUTE writes, so compute it from
		// freshly read rows, never the realtime cache: a dropped echo of my own blind
		// posting (the host's client wrote it) leaves the cache at my pre-blind stack,
		// and spending from that both re-spends the blind and mints the difference
		// into the pot — the intermittent "table is N chips over" imbalance.
		const [{ data: freshMe }, { data: freshSession }] = await Promise.all([
			supabase.from('players').select('*').eq('id', me.id).single(),
			supabase.from('sessions').select('*').eq('id', sessionId).single()
		]);
		const meRow = (freshMe as Player | null) ?? me;
		const sRow = (freshSession as Session | null) ?? session;
		if (amount > meRow.stack) return "You don't have enough chips.";

		// A raise tops an existing bet; otherwise it's an opening bet (postflop, current_bet 0).
		const eventType = sRow.current_bet > 0 ? 'raise' : 'bet';
		const eventStreet = session.street;
		const newStack = meRow.stack - amount;
		const newPot = sRow.pot + amount;
		const newRoundBet = meRow.current_round_bet + amount;
		const newHandTotalBet = meRow.hand_total_bet + amount;
		const newSessionBet = Math.max(sRow.current_bet, newRoundBet);

		// An all-in that falls short of a full raise does NOT reopen the betting, so the
		// players who already acted keep their acted state: they still owe the difference
		// (isStreetOver compares round bets, so it will not call the street done while
		// anyone is short of the new total), but they are answering the old action rather
		// than getting a fresh one. Anyone yet to act this street has acted_on_street null
		// already and is untouched either way.
		const reopensBetting = !(newStack === 0 && newRoundBet < minRaiseTotal(sRow));

		players = players.map((p) => {
			if (p.id === me!.id)
				return {
					...p,
					stack: newStack,
					current_round_bet: newRoundBet,
					acted_on_street: eventStreet,
					hand_total_bet: newHandTotalBet
				};
			// A bet/raise reopens the street: everyone else must act again. Clearing acted_on_street
			// to null makes acted_on_street === session.street false for them.
			if (reopensBetting && p.is_active && !p.folded) return { ...p, acted_on_street: null };
			return p;
		});
		session = { ...session, pot: newPot, current_bet: newSessionBet };

		const otherNonFolded = players.filter((p) => p.is_active && !p.folded && p.id !== me!.id);

		const [stackRes, potRes] = await Promise.all([
			supabase
				.from('players')
				.update({
					stack: newStack,
					current_round_bet: newRoundBet,
					acted_on_street: eventStreet,
					hand_total_bet: newHandTotalBet
				})
				.eq('id', me.id),
			supabase
				.from('sessions')
				.update({ pot: newPot, current_bet: newSessionBet })
				.eq('id', sessionId),
			reopensBetting && otherNonFolded.length > 0
				? supabase
						.from('players')
						.update({ acted_on_street: null })
						.in(
							'id',
							otherNonFolded.map((p) => p.id)
						)
				: Promise.resolve()
		]);

		if (stackRes.error || potRes.error) {
			await load();
			return 'Bet failed, try again.';
		}

		await logEvent(sessionId, eventType, {
			playerId: me.id,
			amount: newRoundBet,
			street: eventStreet,
			// Nothing behind: this bet or raise was a shove. newStack comes off the freshly
			// read row, so it is the real remainder rather than a cached one.
			allIn: newStack === 0
		});

		if (session)
			await advanceTurnService(
				session,
				players.filter((p) => p.is_active)
			);
		return '';
	}

	async function passTurn(outOfTurn = false) {
		if (!me || !session) return;
		if (outOfTurn) await resolveInterveningBeforeMe();
		if (!me || !session) return;
		const checkStreet = session.street;
		players = players.map((p) => (p.id === me!.id ? { ...p, acted_on_street: checkStreet } : p));
		await Promise.all([
			supabase.from('players').update({ acted_on_street: checkStreet }).eq('id', me.id),
			advanceTurnService(
				session,
				players.filter((p) => p.is_active)
			)
		]);
		await logEvent(sessionId, 'check', { playerId: me.id, street: checkStreet });
	}

	async function fold() {
		if (!me || !session) return;

		// Out of turn: an instant self-fold. We don't advance the turn or touch the players
		// ahead of us — the current actor still acts; we're just declaring we're out.
		if (session.current_actor_id !== me.id) {
			players = players.map((p) =>
				p.id === me!.id ? { ...p, folded: true, acted_on_street: session!.street } : p
			);
			await supabase
				.from('players')
				.update({ folded: true, acted_on_street: session.street })
				.eq('id', me.id);
			await logEvent(sessionId, 'fold', { playerId: me.id, street: session.street });
			return;
		}

		const activePlayers = players.filter((p) => p.is_active);
		await foldHandService(me, session, activePlayers);
		players = players.map((p) =>
			p.id === me!.id ? { ...p, folded: true, acted_on_street: session!.street } : p
		);
	}

	async function call(outOfTurn = false) {
		if (!me || !session) return;
		if (outOfTurn) await resolveInterveningBeforeMe();
		if (!me || !session) return;
		const myPlayer = me;
		const mySession = session;
		const activePlayers = players.filter((p) => p.is_active);
		const owed = mySession.current_bet - myPlayer.current_round_bet;
		const callAmount = Math.min(owed, myPlayer.stack);

		players = players.map((p) =>
			p.id === myPlayer.id
				? {
						...p,
						stack: p.stack - callAmount,
						current_round_bet: p.current_round_bet + callAmount,
						acted_on_street: mySession.street,
						hand_total_bet: p.hand_total_bet + callAmount
					}
				: p
		);
		if (callAmount > 0) session = { ...session, pot: session.pot + callAmount };

		await callBetService(mySession, myPlayer, activePlayers);
	}

	async function awardPot(winnerId: string, amount: number) {
		if (!session) return;

		if (!firstPotWinnerId) {
			firstPotWinnerId = winnerId;
			handPotTotal = session.pot;
		}

		const winner = players.find((p) => p.id === winnerId);
		if (!winner) return;
		const newStack = winner.stack + amount;
		const newPot = session.pot - amount;

		players = players.map((p) => (p.id === winnerId ? { ...p, stack: newStack } : p));
		session = { ...session, pot: newPot };

		await awardPotService(sessionId, winnerId, winner.stack, amount, session.pot + amount);
	}

	async function doRebuy(amount: number) {
		if (!me) return;
		await doRebuyService(me, amount);
	}

	async function performEndHand() {
		if (!session) return;
		const winner = firstPotWinnerId;
		const potTotal = handPotTotal;
		firstPotWinnerId = null;
		handPotTotal = 0;
		resetAwards();

		// Cash escalation: a hand that eliminated anybody climbs one rung of the
		// doubling ladder — once, no matter how many players busted. Newly busted =
		// dealt in (hand_total_bet > 0) but out of chips after awards; players dealt
		// out earlier have hand_total_bet 0 so they never recount. Runs before the
		// deal so postBlinds posts the new blinds for the very next hand.
		let dealSession = session;
		if (cashEscalationActive(session)) {
			const anyBusted = players.some(
				(p) => p.is_active && p.stack === 0 && p.hand_total_bet > 0
			);
			if (anyBusted) {
				await advanceBlindLevelService(session);
				const schedule = session.blind_schedule;
				const target = Math.min((session.blind_level ?? 0) + 1, schedule.length - 1);
				const level = schedule[target];
				dealSession = {
					...session,
					blind_level: target,
					small_blind: level.small_blind,
					big_blind: level.big_blind
				};
			}
		}

		// The rows endHand actually worked from: post-award, pre-blind, straight out of the
		// database. The cached `players` is not safe to judge the game over by — a rebuy
		// landing while the award echo is still in flight would look like a busted player,
		// and the session would close under someone who had just bought back in.
		const roster = (await endHandService(dealSession, players, winner, potTotal)) ?? players;

		// Last player standing wins: nobody is left to deal to, so the game is over and
		// everyone lands on the cashout page. The current_actor_id check keeps a stray
		// lobby "Next hand" tap (game not started, one player seated) from ending it.
		if (session.current_actor_id !== null) {
			const withChips = roster.filter((p) => p.is_active && p.stack > 0);
			if (withChips.length <= 1) await endSessionService(sessionId);
		}
	}

	async function performVoidHand() {
		if (!session) return;
		firstPotWinnerId = null;
		handPotTotal = 0;
		resetAwards();
		// Fresh rows as read before the refund, for the same reason performEndHand wants
		// them; the refund is still to be added on, hence the stack + hand_total_bet below.
		const roster = (await voidHandService(session, players)) ?? players;

		// Same last-player-standing check as performEndHand, with refunds counted —
		// voiding is how the host moves on after everyone else has left mid-hand.
		if (session.current_actor_id !== null) {
			const withChips = roster.filter((p) => p.is_active && p.stack + p.hand_total_bet > 0);
			if (withChips.length <= 1) await endSessionService(sessionId);
		}
	}

	async function performResetHand() {
		if (!session) return;
		firstPotWinnerId = null;
		handPotTotal = 0;
		resetAwards();
		await resetHandService(session, players);
	}

	async function performSetDealer(playerId: string) {
		if (!session) return;
		await setDealerService(session, players, playerId);
	}

	async function performClaimHost() {
		if (!me) return;
		const host = players.find((p) => p.is_host);
		await claimHostService(me, host);
	}

	async function performEndSession() {
		await endSessionService(sessionId);
	}

	async function performLeaveTable() {
		if (!me || !session) return;
		await leaveTableService(me, session, players);
	}

	async function performKickPlayer(playerId: string) {
		if (!session) return;
		const target = players.find((p) => p.id === playerId);
		if (!target) return;
		await kickPlayerService(target, session, players);
	}

	async function performStartGame() {
		if (!session) return;
		await startGameService(
			session,
			players.filter((p) => p.is_active),
			players
		);
	}

	async function performReorderSeats(newOrder: Player[]) {
		if (!session) return;
		const activePlayers = players.filter((p) => p.is_active);
		await reorderSeatsService(session, activePlayers, newOrder);
	}

	// Host picks a schedule level to apply from the next deal. The local session is
	// updated optimistically so an immediate Reset hand re-posts the new blinds even
	// before the realtime echo lands.
	async function performSetBlindLevel(levelIdx: number) {
		if (!session) return;
		const level = session.blind_schedule?.[levelIdx];
		if (!level) return;
		session = {
			...session,
			blind_level: levelIdx,
			small_blind: level.small_blind,
			big_blind: level.big_blind
		};
		await setBlindLevelService(session, levelIdx);
	}

	// Applies the confirmed imbalance to one player's stack (host picks who, guided
	// by the ledger). Uses the confirmed value, not the live one, so a mid-action
	// blip can't be "repaired" into a real imbalance.
	async function performAdjustChips(playerId: string) {
		if (!session) return;
		const amount = confirmedImbalance;
		if (amount === 0) return;
		const target = players.find((p) => p.id === playerId);
		if (!target) return;
		players = players.map((p) => (p.id === playerId ? { ...p, stack: p.stack + amount } : p));
		confirmedImbalance = 0;
		imbalanceTicks = 0;
		await adjustChipsService(sessionId, target, amount);
	}

	// Everything a bug report about an imbalance needs, as a JSON string: what this
	// client believed (the realtime cache), what the database actually holds, chip
	// sums for both, and the event log from the start of the PRECEDING hand onward.
	// Cache-vs-database divergence is the signature of the lost-write bugs the
	// imbalance banner exists to catch, which is why both snapshots are included.
	async function buildDebugReport(): Promise<string> {
		const cachedSession = session;
		const cachedPlayers = players;

		const [{ data: freshSession }, { data: freshPlayers }, { data: recentEvents }] =
			await Promise.all([
				supabase.from('sessions').select('*').eq('id', sessionId).single(),
				supabase.from('players').select('*').eq('session_id', sessionId).order('seat_order'),
				supabase
					.from('events')
					.select('*')
					.eq('session_id', sessionId)
					.order('seq', { ascending: false })
					.limit(300)
			]);

		const dbSession = (freshSession as Session | null) ?? null;
		const dbPlayers = (freshPlayers as Player[] | null) ?? [];

		// Names for annotating events; fall back to a short id for departed rows.
		const nameOf = (id: string | null) => {
			if (!id) return null;
			const p =
				dbPlayers.find((x) => x.id === id) ?? cachedPlayers.find((x) => x.id === id);
			return p ? p.display_name : id.slice(0, 8);
		};

		const orderedEvents = ((recentEvents as GameEvent[] | null) ?? []).sort(
			(a, b) => a.seq - b.seq
		);
		// Keep everything from the second-to-last 'deal' marker: the full preceding
		// hand plus the current one.
		const dealSeqs = orderedEvents.filter((e) => e.type === 'deal').map((e) => e.seq);
		const fromSeq = dealSeqs.length >= 2 ? dealSeqs[dealSeqs.length - 2] : (dealSeqs[0] ?? 0);
		const handEvents = orderedEvents
			.filter((e) => e.seq >= fromSeq)
			.map((e) => ({
				seq: e.seq,
				type: e.type,
				player: nameOf(e.player_id),
				target: nameOf(e.target_player_id),
				amount: e.amount,
				street: e.street,
				at: e.created_at
			}));

		const sums = (rows: Player[], pot: number | null | undefined) => {
			const buyins = rows.reduce((sum, p) => sum + p.total_buyin, 0);
			const stacks = rows.reduce((sum, p) => sum + p.stack, 0);
			const bets = rows.reduce((sum, p) => sum + p.hand_total_bet, 0);
			return {
				buyins,
				stacks,
				handBets: bets,
				pot: pot ?? 0,
				imbalance: buyins - stacks - (pot ?? 0)
			};
		};

		return JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				confirmedImbalance,
				database: dbSession
					? { sums: sums(dbPlayers, dbSession.pot), session: dbSession, players: dbPlayers }
					: 'fetch failed',
				thisClientCache: cachedSession
					? {
							sums: sums(cachedPlayers, cachedSession.pot),
							session: cachedSession,
							players: cachedPlayers
						}
					: null,
				eventsSincePrecedingHand: handEvents
			},
			null,
			2
		);
	}

	async function performGiveChips(recipientId: string, amount: number) {
		if (!me) return;
		const recipient = players.find((p) => p.id === recipientId);
		if (!recipient || !recipient.is_active || recipient.id === me.id) return;
		if (!Number.isInteger(amount) || amount <= 0 || amount > me.stack) return;
		const giver = me;
		players = players.map((p) => {
			if (p.id === giver.id) return { ...p, stack: p.stack - amount };
			if (p.id === recipient.id) return { ...p, stack: p.stack + amount };
			return p;
		});
		await giveChipsService(giver, recipient, amount);
	}

	return {
		get session() {
			return session;
		},
		get players() {
			return players;
		},
		get events() {
			return events;
		},
		get me() {
			return me;
		},
		get currentActor() {
			return currentActor;
		},
		get isMyTurn() {
			return isMyTurn;
		},
		get playersBeforeMe() {
			return playersBeforeMe;
		},
		get staleHost() {
			return staleHost;
		},
		get ended() {
			return ended;
		},
		get seriesName() {
			return seriesName;
		},
		get loading() {
			return loading;
		},
		get hasBlindSchedule() {
			return hasBlindSchedule;
		},
		get blindTimeRemaining() {
			return blindTimeRemaining;
		},
		get blindTimeDisplay() {
			return blindTimeDisplay;
		},
		get remainingPots() {
			return remainingPots;
		},
		// 0 on the first "who had the best hand?" question, 1+ for leftover side pots
		get awardRound() {
			return awardRounds.length;
		},
		get streetComplete() {
			return streetComplete;
		},
		get canConfirmNextStreet() {
			return canConfirmNextStreet;
		},
		get nextStreetAction() {
			return nextStreetAction;
		},
		get runOut() {
			return runOut;
		},
		// Non-zero only after the mismatch has held steady for ~5s; positive = short.
		get chipImbalance() {
			return confirmedImbalance;
		},
		get minRaiseAdd() {
			return minRaiseAdd;
		},
		get canRaise() {
			return canRaise;
		},
		get actionPending() {
			return actionPending;
		},
		init,
		destroy,
		// Chip-moving actions are serialised — a second tap while one is in flight is a no-op.
		placeBet: (amount: number, outOfTurn = false) =>
			runExclusive(() => placeBet(amount, outOfTurn), ''),
		awardPot: (winnerId: string, amount: number) =>
			runExclusive(() => awardPot(winnerId, amount), undefined),
		awardBestHand: (winnerIds: string[]) =>
			runExclusive(() => awardBestHand(winnerIds), undefined),
		giveChips: (recipientId: string, amount: number) =>
			runExclusive(() => performGiveChips(recipientId, amount), undefined),
		adjustChips: (playerId: string) => runExclusive(() => performAdjustChips(playerId), undefined),
		buildDebugReport,
		resetAwards,
		confirmNextStreet: () => runExclusive(confirmNextStreet, undefined),
		passTurn: (outOfTurn = false) => runExclusive(() => passTurn(outOfTurn), undefined),
		fold: () => runExclusive(fold, undefined),
		call: (outOfTurn = false) => runExclusive(() => call(outOfTurn), undefined),
		doRebuy,
		endHand: () => runExclusive(performEndHand, undefined),
		voidHand: () => runExclusive(performVoidHand, undefined),
		resetHand: () => runExclusive(performResetHand, undefined),
		setDealer: (playerId: string) => runExclusive(() => performSetDealer(playerId), undefined),
		claimHost: performClaimHost,
		endSession: () => runExclusive(performEndSession, undefined),
		leaveTable: performLeaveTable,
		startGame: performStartGame,
		setBlindLevel: performSetBlindLevel,
		kickPlayer: performKickPlayer,
		reorderSeats: performReorderSeats
	};
}

export type TableStore = ReturnType<typeof createTableStore>;
