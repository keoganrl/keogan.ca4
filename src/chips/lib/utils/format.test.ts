import { describe, it, expect } from 'vitest';
import { byNet, netResult, netColor } from './format';

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
