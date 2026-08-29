import { supabase } from '../supabase';
import type { Series } from '../types';

/**
 * Reading and creating series. There is deliberately no way to END one here.
 *
 * Ending a series freezes its leaderboard into a committed snapshot and then
 * deletes every session in it, which is not a thing to put behind a button on a
 * phone at a poker table. It is an agent protocol: scripts/end-series.mjs, with the
 * runbook in README.md.
 */

/** Series that can still take new sessions — what the setup screen offers. */
export async function listLiveSeries(): Promise<Series[]> {
	const { data, error } = await supabase
		.from('series')
		.select('*')
		.eq('status', 'live')
		.order('created_at', { ascending: false });
	if (error) throw error;
	return (data ?? []) as Series[];
}

/** Every series, newest first — the directory at /chips/leaderboard. */
export async function listAllSeries(): Promise<Series[]> {
	const { data, error } = await supabase
		.from('series')
		.select('*')
		.order('created_at', { ascending: false });
	if (error) throw error;
	return (data ?? []) as Series[];
}

export async function getSeriesByName(name: string): Promise<Series | null> {
	const { data } = await supabase.from('series').select('*').eq('name', name).maybeSingle();
	return (data as Series) ?? null;
}

/**
 * Creates a series, or explains why it could not.
 *
 * The unique index on name is what actually prevents a duplicate — two people on
 * two phones can reach this at the same moment, and a check-then-insert would let
 * both through. 23505 is Postgres' unique_violation, and here it is not a failure
 * worth an error screen: somebody already made the series you were trying to make,
 * so hand it back and let the caller select it.
 */
export async function createSeries(
	name: string
): Promise<{ series: Series } | { error: string }> {
	const { data, error } = await supabase
		.from('series')
		.insert({ name, status: 'live' })
		.select('*')
		.single();

	if (error) {
		if (error.code === '23505') {
			const existing = await getSeriesByName(name);
			if (existing) {
				return existing.status === 'live'
					? { series: existing }
					: { error: `${name} has already been ended.` };
			}
			return { error: `${name} already exists.` };
		}
		return { error: 'Could not create that series. Check your connection.' };
	}
	return { series: data as Series };
}

/**
 * The series a session belongs to, or null if it was a one-off.
 *
 * Everything that distinguishes single from series play downstream of the table
 * asks this: whether the game-over screen offers a leaderboard link, and whether it
 * asks for a recap at all.
 */
export async function getSeriesForSession(
	sessionId: string
): Promise<{ id: string; name: string } | null> {
	const { data } = await supabase
		.from('sessions')
		.select('series_id, series(name)')
		.eq('id', sessionId)
		.maybeSingle();

	const row = data as { series_id: string | null; series: { name: string } | null } | null;
	if (!row?.series_id || !row.series) return null;
	return { id: row.series_id, name: row.series.name };
}
