// Demo-able clock. ALL time reads in backend code go through here (never `new Date()`
// / `Date.now()` directly) so the demo console can fast-forward days in seconds.
//
//   now()      -> ms since epoch (real time + demo offset)
//   nowISO()   -> ISO string of now()
//   advance(ms)-> move the demo clock forward; returns new offset
//   offset()   -> current demo offset in ms
//   reset()    -> back to real time
import { EventEmitter } from 'node:events';

let offsetMs = 0;

// Emits 'advance' with { offsetMs, byMs } so the scheduler can run due jobs instantly.
export const clockEvents = new EventEmitter();

export const now = () => Date.now() + offsetMs;
export const nowISO = () => new Date(now()).toISOString();
export const offset = () => offsetMs;

export function advance(ms) {
  if (!Number.isFinite(ms) || ms < 0) throw new Error('advance(ms) needs a non-negative number');
  offsetMs += ms;
  clockEvents.emit('advance', { offsetMs, byMs: ms });
  return offsetMs;
}

export function setOffset(ms) {
  offsetMs = ms;
}

export function reset() {
  offsetMs = 0;
}

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
