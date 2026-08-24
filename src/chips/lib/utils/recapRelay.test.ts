import { describe, it, expect } from 'vitest';
import { makeThrottle } from './recapRelay';

describe('makeThrottle', () => {
	it('lets the first send through', () => {
		const allow = makeThrottle(100, () => 0);
		expect(allow()).toBe(true);
	});

	it('drops sends inside the interval and allows the next one after it', () => {
		let t = 0;
		const allow = makeThrottle(100, () => t);

		expect(allow()).toBe(true); // t=0, first
		t = 40;
		expect(allow()).toBe(false); // too soon
		t = 90;
		expect(allow()).toBe(false); // still too soon
		t = 100;
		expect(allow()).toBe(true); // interval elapsed
		t = 150;
		expect(allow()).toBe(false); // measured from the last ALLOWED send, not the last call
	});

	it('never drops a forced send', () => {
		let t = 0;
		const allow = makeThrottle(100, () => t);

		expect(allow()).toBe(true);
		t = 1;
		// The final message carries the complete text and tells the other phones to stop
		// their caret. Losing it to the throttle would leave them blinking until their
		// poll caught up.
		expect(allow(true)).toBe(true);
	});

	it('restarts the interval from a forced send', () => {
		let t = 0;
		const allow = makeThrottle(100, () => t);

		expect(allow(true)).toBe(true);
		t = 50;
		expect(allow()).toBe(false);
		t = 100;
		expect(allow()).toBe(true);
	});
});
