import type { Player } from '../types';

/**
 * The seating comparator every ordering in the app shares.
 *
 * seat_order alone is not a total order: nothing in the database stops two rows in a
 * session holding the same seat number (a join race assigns one twice, and reorderSeats
 * renumbers only the active rows). Where seats tie, Array.prototype.sort leaves the rows
 * in whatever order the query returned, which differs between clients — and two phones
 * disagreeing about the turn order is how a hand ends up with two players convinced it is
 * their turn. The id tiebreak is arbitrary but identical everywhere, which is the point.
 */
export function bySeat(a: Player, b: Player): number {
	return a.seat_order - b.seat_order || a.id.localeCompare(b.id);
}
