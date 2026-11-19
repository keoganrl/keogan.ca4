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

// Dollars per chip when the session is played for money, null when it is played for
// chips. Every amount in the app is stored and played in chips; this is the one
// conversion, and everything that shows a number goes through formatAmount with it.
// numeric columns can arrive from PostgREST as strings, hence the Number().
export function chipValue(
  session: { money_buyin?: number | string | null; starting_stack: number } | null | undefined
): number | null {
  const money = Number(session?.money_buyin ?? 0);
  const stack = session?.starting_stack ?? 0;
  return money > 0 && stack > 0 ? money / stack : null;
}

// A chip amount as it should read on screen: the bare chip count, or dollars with a
// $ sign when playing for money. Whole dollars drop the cents ($20, not $20.00); any
// other amount shows both digits ($0.10, $24.68). Rounded to the cent, so a stake
// that is not a whole number of cents per chip can be a cent out on a single figure.
export function formatAmount(chips: number, perChip: number | null): string {
  if (perChip === null) return `${chips}`;
  const cents = Math.round(Math.abs(chips) * perChip * 100);
  const whole = cents % 100 === 0;
  const body = (cents / 100).toLocaleString('en-CA', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2
  });
  return `${chips < 0 && cents > 0 ? '-' : ''}$${body}`;
}

// "500 chips" for a chip game, "$10" for a money one, where the $ sign is the unit.
export function amountLabel(chips: number, perChip: number | null): string {
  return perChip === null ? `${chips} chips` : formatAmount(chips, perChip);
}

export function netResult(
  stack: number,
  totalBuyin: number,
  perChip: number | null = null
): string {
  const net = stack - totalBuyin;
  return net >= 0 ? `+${formatAmount(net, perChip)}` : formatAmount(net, perChip);
}

// Class names defined in src/styles/chips.css.
export function netColor(stack: number, totalBuyin: number): string {
  const net = stack - totalBuyin;
  return net > 0 ? 'net-up' : net < 0 ? 'net-down' : 'net-even';
}
