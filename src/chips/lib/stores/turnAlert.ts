import { writable } from 'svelte/store';

// How loudly this device announces that the action is on you. A per-DEVICE preference,
// not a table setting: it changes nothing for anyone else, so it lives in localStorage
// beside the identity id rather than in the database.
//
//  - 'standard' — the black turn bar, pulsing.
//  - 'loud'     — the same bar, bigger and multicoloured, plus an animated border around
//                 the whole page. For people who need to be shouted at.
export type TurnAlertStyle = 'standard' | 'loud';

const KEY = 'poker_turn_alert';

// Components render with client:only, but guard anyway so nothing touches
// localStorage during a build.
const browser = typeof window !== 'undefined';

function stored(): TurnAlertStyle {
  if (!browser) return 'standard';
  try {
    return localStorage.getItem(KEY) === 'loud' ? 'loud' : 'standard';
  } catch {
    // Storage blocked (private mode / site data off) — everyone gets the standard bar.
    return 'standard';
  }
}

export const turnAlert = writable<TurnAlertStyle>(stored());

export function setTurnAlert(style: TurnAlertStyle) {
  turnAlert.set(style);
  if (!browser) return;
  try {
    localStorage.setItem(KEY, style);
  } catch {
    // Same as above: the choice still applies to this session, it just won't stick.
  }
}
