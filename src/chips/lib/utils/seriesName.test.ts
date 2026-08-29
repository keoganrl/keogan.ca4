import { describe, it, expect } from 'vitest';
import { isValidPrefix, buildSeriesName } from './seriesName';

describe('isValidPrefix', () => {
	it('accepts 2 to 5 letters in either case', () => {
		expect(isValidPrefix('DW')).toBe(true);
		expect(isValidPrefix('dw')).toBe(true);
		expect(isValidPrefix('UWATE')).toBe(true);
	});

	it('rejects anything outside 2-5 letters', () => {
		expect(isValidPrefix('D')).toBe(false);
		expect(isValidPrefix('TOOLONG')).toBe(false);
		expect(isValidPrefix('')).toBe(false);
	});

	it('rejects digits, spaces and punctuation', () => {
		// A name with a stray character in the prefix would still sort, but the
		// hyphen is the separator the directory splits on.
		expect(isValidPrefix('DW1')).toBe(false);
		expect(isValidPrefix('D W')).toBe(false);
		expect(isValidPrefix('DW-')).toBe(false);
	});

	it('ignores surrounding whitespace, since the input is typed', () => {
		expect(isValidPrefix('  DW  ')).toBe(true);
	});
});

describe('buildSeriesName', () => {
	it('uppercases the prefix and appends the local year and month', () => {
		expect(buildSeriesName('dw', new Date(2026, 6, 15))).toBe('DW-2026-07');
	});

	it('zero-pads single-digit months', () => {
		// The padding is what makes lexicographic order chronological: without it
		// 'DW-2026-10' sorts before 'DW-2026-9' and the directory lies.
		expect(buildSeriesName('DW', new Date(2026, 0, 1))).toBe('DW-2026-01');
		expect(buildSeriesName('DW', new Date(2026, 8, 30))).toBe('DW-2026-09');
	});

	it('does not pad or truncate the year', () => {
		expect(buildSeriesName('DW', new Date(2026, 11, 31))).toBe('DW-2026-12');
	});

	it('rolls into the next year rather than reusing December', () => {
		expect(buildSeriesName('DW', new Date(2027, 0, 1))).toBe('DW-2027-01');
	});

	it('sorts chronologically as plain strings', () => {
		const names = [
			buildSeriesName('DW', new Date(2026, 8, 1)),
			buildSeriesName('DW', new Date(2027, 0, 1)),
			buildSeriesName('DW', new Date(2026, 11, 1))
		];
		expect([...names].sort()).toEqual(['DW-2026-09', 'DW-2026-12', 'DW-2027-01']);
	});

	it('trims the prefix', () => {
		expect(buildSeriesName(' dw ', new Date(2026, 6, 1))).toBe('DW-2026-07');
	});
});
