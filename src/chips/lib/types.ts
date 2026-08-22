export type SessionStatus = 'waiting' | 'active' | 'paused' | 'ended';
export type GameMode = 'cash' | 'tournament';

export interface BlindLevel {
	level: number;
	small_blind: number;
	big_blind: number;
	duration_minutes: number;
}

export interface Session {
	id: string;
	join_code: string;
	status: SessionStatus;
	game_mode: GameMode;
	host_player_id: string | null;
	small_blind: number;
	big_blind: number;
	// Host-chosen buy-in; every joiner starts with this stack.
	starting_stack: number;
	blind_level: number;
	blind_level_started_at: string | null;
	blind_schedule: BlindLevel[];
	// Whether eliminations automatically climb the ladder. The schedule is always
	// present (it sets the starting blinds and backs the host's manual override),
	// so this is what the setup toggle actually controls.
	auto_escalate: boolean;
	button_player_id: string | null;
	current_actor_id: string | null;
	current_bet: number;
	pot: number;
	street: string;
	created_at: string;
	last_active_at: string | null;
}

export interface Player {
	id: string;
	session_id: string;
	identity_id: string;
	display_name: string;
	stack: number;
	total_buyin: number;
	is_host: boolean;
	is_active: boolean;
	folded: boolean;
	current_round_bet: number;
	// The street ('preflop' | 'flop' | 'turn' | 'river') on which this player most recently acted,
	// or null if they have not acted since the last deal. A player has acted on the current street
	// iff acted_on_street === sessions.street — see isStreetOver in services/table.ts.
	acted_on_street: string | null;
	hand_total_bet: number;
	last_heartbeat_at: string;
	seat_order: number;
}

export type GameEventType =
	| 'deal' // hand-start marker (groups the ledger by hand; not rendered as a line)
	| 'post_sb'
	| 'post_bb'
	| 'bet'
	| 'raise'
	| 'call'
	| 'check'
	| 'fold'
	| 'street'
	| 'win'
	| 'rebuy'
	| 'give' // player-to-player chip transfer; player_id gives, target_player_id receives
	| 'adjust' // host chip-conservation correction; amount signed (+credit / −debit)
	| 'join'
	| 'leave'
	| 'kick';

export interface GameEvent {
	id: string;
	seq: number;
	session_id: string;
	player_id: string | null;
	type: GameEventType;
	amount: number | null;
	street: string | null;
	// recipient for 'give' events; null elsewhere
	target_player_id: string | null;
	// True when this action emptied the player's stack — the moment they went all in.
	// Set on the action itself rather than logged as an extra ledger line, so the log
	// still reads as one line per thing that happened. Databases that predate the
	// column (see logEvent) hand back undefined, which is why this is optional.
	all_in?: boolean;
	created_at: string;
}

export interface LifetimeStat {
	identity_id: string;
	display_name: string;
	sessions_played: number;
	total_net: number;
	biggest_win: number;
	times_first: number;
	times_last: number;
	total_buyin: number;
	// Bets, raises and calls that left the player with nothing behind. Blind posts that
	// happened to be all-in are excluded — see the column in chips-schema.sql. Optional
	// because a database that predates events.all_in has no such column in the view.
	all_ins?: number;
}

// One row per player per ended session (the `session_results` view). The per-session
// grain behind the net chart and the chaos score; `net_bb` is net normalised to big
// blinds, which is the only form comparable across sessions at different stakes.
export interface SessionResult {
	identity_id: string;
	display_name: string;
	session_id: string;
	created_at: string;
	big_blind: number;
	net: number;
	net_bb: number;
}

// One row of the player_stats view (supabase/player-stats.sql): playing-style
// figures reconstructed from the event ledger. Every percentage carries its own
// denominator so the UI can tell "folds to c-bets 0% of the time" (over 40 spots)
// apart from the same number over two.
export interface PlayerStat {
	identity_id: string;
	display_name: string;
	hands: number;
	reliability: 'ok' | 'thin' | 'anecdote';

	vpip_pct: number | null;
	pfr_pct: number | null;
	vpip_pfr_gap: number | null;
	af: number | null;

	cbet_flop_pct: number | null;
	cbet_opps: number;
	fold_to_cbet_pct: number | null;
	faced_cbet_opps: number;

	steal_pct: number | null;
	steal_opps: number;
	fold_to_steal_pct: number | null;
	faced_steal_opps: number;

	wtsd_pct: number | null;
	saw_flop_hands: number;

	vpip_early_pct: number | null;
	early_hands: number;
	vpip_late_pct: number | null;
	late_hands: number;
	vpip_blinds_pct: number | null;
	blind_hands: number;

	chips_won: number;
	biggest_pot: number;
}

// One row of player_profiles: the generated blurb everyone sees, and the coaching
// note shown only to the player it is about. Written by api/profile.js when a
// session ends and the player's numbers have moved (see api/_drift.js).
export interface PlayerProfile {
	identity_id: string;
	profile: string | null;
	coaching: string | null;
	generated_at: string;
}
