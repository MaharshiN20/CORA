// Planning helpers shared by every module that schedules recurring jobs
// (check-ins, meds, refills, outreach, digests). Dependency-free on purpose, so
// feature modules can register planners without import cycles.
import * as clock from './clock.js';

export const ACTIVE_DAYS = 30; // monitoring window after discharge

// ---------- time zones ----------
// A patient's day is THEIR day: check-ins at 09:00 mean 09:00 where they live, not on the server. A
// patient may carry `timezone` (IANA, e.g. "America/Chicago"); without one (or with a name the runtime
// doesn't know) everything uses the server's local time, exactly as before (audit 2026-10-11).
export const tzOf = (p) => {
  const tz = p?.timezone;
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
};

const fmtCache = new Map();
function parts(ms, tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }));
  }
  const o = Object.fromEntries(fmtCache.get(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) };
}
// ms offset of `tz` from UTC at instant `ms`
const offsetAt = (ms, tz) => {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
};

// "HH:MM" on the local calendar day containing dayMs -> ms timestamp
export function atLocalTime(dayMs, hhmm, tz = null) {
  const [h, m] = hhmm.split(':').map(Number);
  if (!tz) {
    const d = new Date(dayMs);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }
  const p = parts(dayMs, tz);
  const wall = Date.UTC(p.y, p.mo - 1, p.d, h, m, 0, 0);
  let at = wall - offsetAt(wall, tz);
  at = wall - offsetAt(at, tz); // once more: the offset may differ across a DST change
  return at;
}

export function localDayKey(ms, tz = null) {
  if (tz) {
    const p = parts(ms, tz);
    return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  }
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 0 = Sunday, on the patient's calendar
export const localWeekday = (ms, tz = null) => (tz ? parts(ms, tz).wd : new Date(ms).getDay());

// Every occurrence of `times` (local HH:MM) in (fromMs, toMs], with a stable key per slot.
export function occurrences(times, fromMs, toMs, tz = null) {
  const out = [];
  for (let day = fromMs - clock.DAY; day <= toMs + clock.DAY; day += clock.DAY) {
    for (const t of times) {
      const at = atLocalTime(day, t, tz);
      if (at > fromMs && at <= toMs) out.push({ at, key: `${localDayKey(at, tz)}T${t}` });
    }
  }
  const seen = new Set();
  return out.sort((a, b) => a.at - b.at).filter((o) => !seen.has(o.key) && seen.add(o.key));
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
