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
	created_at: string;
}

export interface LifetimeStat {
	identity_id: string;
	display_name: string;
	sessions_played: number;
	total_net: number;
	biggest_win: number;
	times_last: number;
	total_buyin: number;
}
