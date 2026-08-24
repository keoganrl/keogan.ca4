import { describe, it, expect } from 'vitest';
import { pollForRecap, type RecapRow } from './recapPolling';

/**
 * A fake clock. Time only moves when the code under test sleeps, so these run
 * instantly and a 90-second timeout costs nothing to assert.
 */
function fakeClock() {
	let t = 0;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
		get elapsed() {
			return t;
		}
	};
}

/** Returns the given rows in order, repeating the last one forever. */
function rows(...sequence: RecapRow[]) {
	let i = 0;
	const calls = { count: 0 };
	const fetchRow = async () => {
		calls.count++;
		const row = sequence[Math.min(i, sequence.length - 1)];
		i++;
		return row;
	};
	return { fetchRow, calls };
}

describe('pollForRecap', () => {
	it('returns the recap once the generating screen stores it', async () => {
		const clock = fakeClock();
		// Claimed and empty for two polls, then the text lands.
		const { fetchRow, calls } = rows(
			{ recap: null },
			{ recap: null },
			{ recap: 'Nobody folded all night.' }
		);

		const result = await pollForRecap(fetchRow, { ...clock, intervalMs: 1000 });

		expect(result).toBe('Nobody folded all night.');
		expect(calls.count).toBe(3);
		// Stops as soon as it has the text rather than polling out the deadline.
		expect(clock.elapsed).toBe(3000);
	});

	it('gives up when the claim has been released', async () => {
		const clock = fakeClock();
		// The row is gone: the generating screen failed and deleted its own claim, so
		// nothing is coming and waiting the full deadline would be waiting for nothing.
		const { fetchRow, calls } = rows(null);

		const result = await pollForRecap(fetchRow, { ...clock, intervalMs: 1000 });

		expect(result).toBeNull();
		expect(calls.count).toBe(1);
	});

	it('gives up when the deadline passes on a claim that never fills', async () => {
		const clock = fakeClock();
		// A claim whose function died hard leaves the row sitting empty forever.
		const { fetchRow } = rows({ recap: null });

		const result = await pollForRecap(fetchRow, {
			...clock,
			intervalMs: 1000,
			timeoutMs: 5000
		});

		expect(result).toBeNull();
		expect(clock.elapsed).toBeLessThanOrEqual(6000);
	});

	it('gives up when the fetch throws', async () => {
		const clock = fakeClock();
		const result = await pollForRecap(
			async () => {
				throw new Error('offline');
			},
			{ ...clock, intervalMs: 1000 }
		);

		expect(result).toBeNull();
	});

	it('treats an empty string as not written yet', async () => {
		const clock = fakeClock();
		const { fetchRow } = rows({ recap: '' }, { recap: 'Late but real.' });

		const result = await pollForRecap(fetchRow, { ...clock, intervalMs: 1000 });

		expect(result).toBe('Late but real.');
	});
});
