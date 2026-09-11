// Final-standings order: biggest net win first. NOT final stack — the two disagree the
// moment anybody rebuys, and net is what the results screen actually prints beside each
// name, so ordering by stack reads as a straightforwardly wrong table.
//
// Ties break by name rather than being left to the input order, so two players who
// finished level can't swap places between renders.
export function byNet(
  a: { stack: number; total_buyin: number; display_name: string },
  b: { stack: number; total_buyin: number; display_name: string }
): number {
  const diff = b.stack - b.total_buyin - (a.stack - a.total_buyin);
  return diff !== 0 ? diff : a.display_name.localeCompare(b.display_name);
}

export function netResult(stack: number, totalBuyin: number): string {
  const net = stack - totalBuyin;
  return net >= 0 ? `+${net}` : `${net}`;
}

// Class names defined in src/styles/chips.css.
export function netColor(stack: number, totalBuyin: number): string {
  const net = stack - totalBuyin;
  return net > 0 ? 'net-up' : net < 0 ? 'net-down' : 'net-even';
}
