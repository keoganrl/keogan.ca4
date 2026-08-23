import type { GameEvent, Session } from '../types';

/**
 * The smallest legal round total for a raise (or an opening bet): double the current
 * bet, or the big blind when opening.
 *
 * This is a house simplification. Real no-limit sizes a minimum raise as "the current
 * bet plus the last raise increment", which in a re-raised pot is smaller than doubling.
 * Doubling is easier to explain across a kitchen table and errs towards bigger raises,
 * so it stays — but it is the rule the short-all-in test below has to use too, or the
 * two would disagree about what counts as a full raise.
 */
export function minRaiseTotal(session: Pick<Session, 'current_bet' | 'big_blind'>): number {
	return session.current_bet > 0 ? session.current_bet * 2 : session.big_blind;
}

/** The bet and raise events of the current hand's current street, oldest first. */
function levelsThisStreet(events: GameEvent[], street: string): GameEvent[] {
	// Everything after the last 'deal' marker is the hand being played now.
	let start = 0;
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i].type === 'deal') {
			start = i + 1;
			break;
		}
	}
	return events
		.slice(start)
		.filter((e) => e.street === street && (e.type === 'bet' || e.type === 'raise'));
}

/**
 * True when the bet everyone is facing was set by an all-in for LESS than a full raise.
 *
 * Poker's rule: an all-in that does not amount to a full raise does not reopen the
 * betting. Someone who has already acted may call the extra or fold, but may not raise
 * again — otherwise a player one chip short of a real raise could be used to re-open an
 * action that was closed, which is the classic angle the rule exists to prevent.
 *
 * Derived from the ledger rather than stored on the session: `raise` events record the
 * raise-TO total and carry the all-in flag, so the street's bet levels and how the last
 * one was made are both already written down. Preflop the big blind is the implicit
 * opening level, since blinds are logged without a street.
 *
 * Note this asks about the LAST level only. Once someone makes a full raise over the
 * short all-in, the action is legitimately reopened for everybody again.
 */
export function facingShortAllIn(
	events: GameEvent[],
	session: Pick<Session, 'street' | 'big_blind'>
): boolean {
	const levels = levelsThisStreet(events, session.street);
	const last = levels[levels.length - 1];
	if (!last?.all_in) return false;

	const previous =
		levels.length >= 2
			? (levels[levels.length - 2].amount ?? 0)
			: session.street === 'preflop'
				? session.big_blind
				: 0;
	const fullRaise = minRaiseTotal({ current_bet: previous, big_blind: session.big_blind });
	return (last.amount ?? 0) < fullRaise;
}
