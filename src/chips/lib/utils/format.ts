export function netResult(stack: number, totalBuyin: number): string {
  const net = stack - totalBuyin;
  return net >= 0 ? `+${net}` : `${net}`;
}

// Class names defined in src/styles/chips.css.
export function netColor(stack: number, totalBuyin: number): string {
  const net = stack - totalBuyin;
  return net > 0 ? 'net-up' : net < 0 ? 'net-down' : 'net-even';
}
