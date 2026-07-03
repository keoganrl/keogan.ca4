/** Snap a bet amount to the nearest multiple of step, clamped to [0, max]. */
export function snapToStep(amount: number, step: number, max: number): number {
	if (step <= 0) return Math.min(Math.max(0, amount), max);
	return Math.min(max, Math.max(0, Math.round(amount / step) * step));
}
