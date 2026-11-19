import { describe, it, expect } from 'vitest';
import { byNet, netResult, netColor, chipValue, formatAmount, amountLabel } from './format';
import { describeEvent } from './ledger';
import type { GameEvent } from '../types';

describe('money formatting', () => {
  const session = (money_buyin: number | string | null) => ({ money_buyin, starting_stack: 1000 });

  it('is off unless a positive buy-in is set', () => {
    expect(chipValue(session(null))).toBeNull();
    expect(chipValue(session(0))).toBeNull();
    expect(chipValue({ starting_stack: 1000 })).toBeNull();
    expect(chipValue(null)).toBeNull();
  });

  it('reads numeric columns that arrive as strings', () => {
    expect(chipValue(session('20.00'))).toBeCloseTo(0.02);
  });

  it('shows bare chips when playing for chips', () => {
    expect(formatAmount(250, null)).toBe('250');
    expect(amountLabel(500, null)).toBe('500 chips');
    expect(netResult(1200, 1000)).toBe('+200');
  });

  it('shows dollars, dropping cents only on whole amounts', () => {
    const v = chipValue(session(20));
    expect(formatAmount(1000, v)).toBe('$20');
    expect(formatAmount(5, v)).toBe('$0.10');
    expect(formatAmount(1234, v)).toBe('$24.68');
    expect(formatAmount(0, v)).toBe('$0');
    expect(amountLabel(500, v)).toBe('$10');
    expect(formatAmount(100000, v)).toBe('$2,000');
  });

  it('signs net results', () => {
    const v = chipValue(session(20));
    expect(netResult(1260, 1000, v)).toBe('+$5.20');
    expect(netResult(750, 1000, v)).toBe('-$5');
    expect(netResult(1000, 1000, v)).toBe('+$0');
  });

  it('formats log lines in money', () => {
    const v = chipValue(session(20));
    const fmt = (n: number) => formatAmount(n, v);
    const raise = { type: 'raise', amount: 40 } as GameEvent;
    expect(describeEvent(raise, 'Vani', undefined, fmt)).toBe('Vani raises to $0.80');
    expect(describeEvent(raise, 'Vani')).toBe('Vani raises to 40');
    const debit = { type: 'adjust', amount: -50 } as GameEvent;
    expect(describeEvent(debit, 'Vani', undefined, fmt)).toBe(
      'Vani was debited $1 (host correction)'
    );
  });
});

const p = (display_name: string, stack: number, total_buyin: number) => ({
  display_name,
  stack,
  total_buyin
});

describe('byNet', () => {
  it('ranks by net, not by final stack', () => {
    // The live session that found this: Keogan rebought to 1500 and finished 690,
    // Vani bought in 1000 and finished 600. Ordering by stack put Keogan (-810)
    // above Vani (-400) with both nets printed right beside them.
    const order = [p('Keogan', 690, 1500), p('Vani', 600, 1000)].sort(byNet);
    expect(order.map((x) => x.display_name)).toEqual(['Vani', 'Keogan']);
  });

  it('matches stack order when nobody rebought', () => {
    const order = [p('Ethan', 1510, 1000), p('Braeden', 1580, 1000), p('Kinjal', 780, 1000)].sort(
      byNet
    );
    expect(order.map((x) => x.display_name)).toEqual(['Braeden', 'Ethan', 'Kinjal']);
  });

  it('breaks ties by name so the order is stable', () => {
    const players = [p('Zoe', 1000, 1000), p('Alex', 1000, 1000)];
    expect([...players].sort(byNet).map((x) => x.display_name)).toEqual(['Alex', 'Zoe']);
    expect([...players].reverse().sort(byNet).map((x) => x.display_name)).toEqual(['Alex', 'Zoe']);
  });
});

describe('netResult / netColor', () => {
  it('signs the net both ways and marks even', () => {
    expect(netResult(1580, 1000)).toBe('+580');
    expect(netResult(690, 1500)).toBe('-810');
    expect(netResult(1000, 1000)).toBe('+0');
    expect(netColor(1580, 1000)).toBe('net-up');
    expect(netColor(690, 1500)).toBe('net-down');
    expect(netColor(1000, 1000)).toBe('net-even');
  });
});
