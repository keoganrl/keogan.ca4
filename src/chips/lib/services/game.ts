import { supabase } from '../supabase';
import { generateJoinCode } from '../utils/joinCode';
import { logEvent } from './table';
import type { Session, GameMode, BlindLevel } from '../types';

export async function createGame(): Promise<{ id: string; join_code: string }> {
	// Word-only codes collide easily, so skip words that a still-running game is using.
	const { data: inPlay } = await supabase
		.from('sessions')
		.select('join_code')
		.neq('status', 'ended');
	const code = generateJoinCode(inPlay?.map((s) => s.join_code) ?? []);
	const { data, error } = await supabase
		.from('sessions')
		.insert({ join_code: code, status: 'waiting', blind_schedule: [] })
		.select('id')
		.single();
	if (error || !data) throw new Error('Failed to create game');
	return { id: data.id, join_code: code };
}

export async function findGameByCode(code: string): Promise<Session | null> {
	// A code is reused across games over time. Prefer the newest session that is still
	// joinable; fall back to the newest ended one so the caller can say "game over".
	// A live session is always among the newest with its code (createGame won't reuse a
	// live code), so a small window is enough — no need to fetch every historical match.
	const { data } = await supabase
		.from('sessions')
		.select('*')
		.eq('join_code', code)
		.order('created_at', { ascending: false })
		.limit(10);
	if (!data?.length) return null;
	return (data.find((s) => s.status !== 'ended') ?? data[0]) as Session;
}

export async function startSession(
	sessionId: string,
	identityId: string,
	name: string,
	buyIn: number,
	smallBlind: number,
	bigBlind: number,
	gameMode: GameMode = 'cash',
	blindSchedule: BlindLevel[] = [],
	autoEscalate = true
): Promise<void> {
	const blindLevelStartedAt =
		gameMode === 'tournament' && blindSchedule.length > 0 ? new Date().toISOString() : null;

	const settings = {
		small_blind: smallBlind,
		big_blind: bigBlind,
		starting_stack: buyIn,
		status: 'active',
		game_mode: gameMode,
		blind_schedule: blindSchedule,
		blind_level: 0,
		blind_level_started_at: blindLevelStartedAt
	};

	let { error: sessionError } = await supabase
		.from('sessions')
		.update({ ...settings, auto_escalate: autoEscalate })
		.eq('id', sessionId);
	// sessions.auto_escalate was added later; if a database hasn't had the migration
	// run yet, start the game without it rather than failing outright (escalation
	// then falls back to on — see cashEscalationActive).
	if (sessionError) {
		({ error: sessionError } = await supabase
			.from('sessions')
			.update(settings)
			.eq('id', sessionId));
	}
	if (sessionError) throw new Error('Failed to update session');

	const { data: playerData, error: playerError } = await supabase
		.from('players')
		.insert({
			session_id: sessionId,
			identity_id: identityId,
			display_name: name,
			stack: buyIn,
			total_buyin: buyIn,
			is_host: true,
			seat_order: 0
		})
		.select('id')
		.single();
	if (playerError || !playerData) throw new Error('Failed to create player');

	await supabase.from('sessions').update({ button_player_id: playerData.id }).eq('id', sessionId);
	await logEvent(sessionId, 'join', { playerId: playerData.id });
}

// Merges duplicate lifetime identities into one (the private-tab problem: every
// incognito visit mints a fresh players_identity row, so one human shows up on the
// leaderboard several times). Every player row belonging to a ghost identity is
// repointed at `keepId`, then the ghost identity rows are deleted. lifetime_stats
// groups by identity, so the history collapses into a single entry — and because
// sessions_played counts distinct sessions, a game where the person accidentally
// played under two identities still counts once.
export async function mergeIdentities(keepId: string, ghostIds: string[]): Promise<void> {
	const ghosts = ghostIds.filter((id) => id !== keepId);
	if (!keepId || !ghosts.length) return;
	// Repoint before deleting: players.identity_id references players_identity.
	await supabase.from('players').update({ identity_id: keepId }).in('identity_id', ghosts);
	await supabase.from('players_identity').delete().in('id', ghosts);
}

// The joiner does not choose a stack: the host fixed sessions.starting_stack at setup,
// and every joiner buys in for exactly that amount.
export async function joinSession(
	sessionId: string,
	identityId: string,
	name: string
): Promise<'joined' | 'rejoined'> {
	// Deliberately not .single(): it errors on more than one row, and that error is
	// indistinguishable here from "no row", so a session that had somehow seated this
	// identity twice would seat them a third time on every rejoin. Taking the first row
	// re-seats them in the chair they already have.
	const existing = (
		await supabase
			.from('players')
			.select('id, is_active')
			.eq('session_id', sessionId)
			.eq('identity_id', identityId)
			.order('seat_order')
			.limit(1)
	).data?.[0];

	if (existing) {
		// A kicked or departed player keeps their row (is_active=false) — reactivate it or
		// they bounce straight back to /cashout. They sit out folded until the next deal;
		// hand_total_bet is left alone so pots stay correct if they left mid-hand.
		if (!existing.is_active) {
			await supabase
				.from('players')
				.update({ is_active: true, folded: true })
				.eq('id', existing.id);
			await logEvent(sessionId, 'join', { playerId: existing.id });
		}
		return 'rejoined';
	}

	const [{ data: currentPlayers }, { data: sessionRow }] = await Promise.all([
		supabase
			.from('players')
			.select('seat_order')
			.eq('session_id', sessionId)
			.order('seat_order', { ascending: false })
			.limit(1),
		supabase
			.from('sessions')
			.select('starting_stack, current_actor_id')
			.eq('id', sessionId)
			.single()
	]);

	const nextSeat = currentPlayers?.length ? currentPlayers[0].seat_order + 1 : 1;
	const buyIn = sessionRow?.starting_stack ?? 1000;
	// A hand in progress (current_actor_id set) can't absorb a new player: joining
	// unfolded would add them to the turn order mid-street and stall isStreetOver.
	// They start folded (dealt out) and endHand's reset deals them into the next hand.
	const handInProgress = (sessionRow?.current_actor_id ?? null) !== null;

	const { data: inserted, error } = await supabase
		.from('players')
		.insert({
			session_id: sessionId,
			identity_id: identityId,
			display_name: name,
			stack: buyIn,
			total_buyin: buyIn,
			is_host: false,
			folded: handInProgress,
			seat_order: nextSeat
		})
		.select('id')
		.single();

	if (error || !inserted) {
		// The unique index on (session_id, identity_id) rejects a second seat for the same
		// person, which is what two tabs tapping "Take a seat" together looks like. Losing
		// that race is a rejoin, not a failure — the seat the other tab won is theirs.
		const { data: raced } = await supabase
			.from('players')
			.select('id')
			.eq('session_id', sessionId)
			.eq('identity_id', identityId)
			.limit(1);
		if (raced?.length) return 'rejoined';
		throw new Error('Failed to join session');
	}

	await logEvent(sessionId, 'join', { playerId: inserted.id });

	return 'joined';
}
