// Planning helpers shared by every module that schedules recurring jobs
// (check-ins, meds, refills, outreach, digests). Dependency-free on purpose, so
// feature modules can register planners without import cycles.
import * as clock from './clock.js';

export const ACTIVE_DAYS = 30; // monitoring window after discharge

// "HH:MM" on the local calendar day containing dayMs -> ms timestamp
export function atLocalTime(dayMs, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(dayMs);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

export function localDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Every occurrence of `times` (local HH:MM) in (fromMs, toMs], with a stable key per slot.
export function occurrences(times, fromMs, toMs) {
  const out = [];
  for (let day = fromMs - clock.DAY; day <= toMs + clock.DAY; day += clock.DAY) {
    for (const t of times) {
      const at = atLocalTime(day, t);
      if (at > fromMs && at <= toMs) out.push({ at, key: `${localDayKey(at)}T${t}` });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export function isMonitored(p, atMs = clock.now()) {
  if (p.active === false) return false;
  const since = atMs - Date.parse(p.dischargedAt);
  return since >= 0 && since <= ACTIVE_DAYS * clock.DAY;
}

// Planner registry: fn(patient, fromMs, toMs) creates that module's jobs in the window.
const planners = [];
export const addPlanner = (fn) => planners.push(fn);
export const allPlanners = () => planners;
