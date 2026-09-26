// Wires job kinds to the scheduler and plans each patient's recurring jobs.
//
//   start()              -> plan + 30s tick loop (server only)
//   afterAdvance(byMs)   -> plan the window the demo clock skipped, then run what's due
//   planAll(fromMs, toMs)-> create recurring jobs in [from, to] (idempotent)
//
// Planning only covers times after the last planning point: a fresh server start
// never fires a burst of "missed" morning check-ins at every patient, but a
// demo fast-forward plans the skipped window so the misses are recorded.
import * as store from '../store.js';
import * as clock from './clock.js';
import * as scheduler from './scheduler.js';
import * as channels from '../channels/index.js';
import { startCheckin } from './agent.js';
import { isActive as checkinActive } from './checkin.js';
import { scoreRisk } from './risk.js';

const HORIZON_MS = 48 * clock.HOUR;
const TICK_MS = 30_000;
const ACTIVE_DAYS = 30; // monitoring window after discharge

// Check-in times by plan (local time). High risk (2/day) adds an evening check.
export const CHECKIN_TIMES = { 1: ['09:00'], 2: ['09:00', '19:00'] };

// ---------- job kinds ----------

scheduler.defineJob('checkin_due', {
  collapse: true,
  async run(job) {
    const p = store.getPatient(job.patientId);
    if (checkinActive(p)) return { skipped: 'checkin already in progress' };
    const replies = await startCheckin(p.id);
    for (const r of replies) await channels.sendToPatient(p, r);
    store.audit('checkin_sent', p.id, { jobId: job.id, scheduledFor: job.dueAt });
    return { sent: replies.length };
  },
});

// ---------- planning ----------

// "HH:MM" on the local calendar day containing dayMs -> ms timestamp
export function atLocalTime(dayMs, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(dayMs);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

const localDayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function isMonitored(p, atMs = clock.now()) {
  if (p.active === false) return false;
  const since = atMs - Date.parse(p.dischargedAt);
  return since >= 0 && since <= ACTIVE_DAYS * clock.DAY;
}

// Every occurrence of `times` (local HH:MM) in (fromMs, toMs].
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

// Extra planners registered by feature modules (meds, pharmacy, outreach, digest…).
const planners = [];
export const addPlanner = (fn) => planners.push(fn);

export function planPatient(p, fromMs, toMs) {
  const { plan } = scoreRisk(p);
  const times = CHECKIN_TIMES[plan.checkinsPerDay] ?? CHECKIN_TIMES[1];
  for (const { at, key } of occurrences(times, fromMs, toMs)) {
    if (!isMonitored(p, at)) continue;
    scheduler.schedule({ kind: 'checkin_due', patientId: p.id, dueAt: at, key: `checkin_due:${p.id}:${key}` });
  }
  for (const planner of planners) planner(p, fromMs, toMs);
}

export function planAll(fromMs, toMs) {
  for (const p of store.listPatients()) planPatient(p, fromMs, toMs);
}

// ---------- lifecycle ----------

let lastPlannedAt = null;
let timer = null;

function planFrom(fromMs) {
  const now = clock.now();
  planAll(fromMs, now + HORIZON_MS);
  lastPlannedAt = now;
}

export function start({ intervalMs = TICK_MS } = {}) {
  planFrom(clock.now());
  if (intervalMs) {
    timer = setInterval(() => {
      planFrom(lastPlannedAt ?? clock.now());
      scheduler.tick().catch((e) => console.error('[scheduler] tick failed', e));
    }, intervalMs);
    timer.unref?.();
  }
  return scheduler.tick();
}

export function stop() {
  clearInterval(timer);
  timer = null;
  lastPlannedAt = null;
}

// Called by POST /api/demo/advance after the clock moves: plan the skipped window, run due jobs.
export async function afterAdvance(byMs) {
  planFrom(clock.now() - byMs);
  return scheduler.tick();
}

// Re-plan from "now" (used after reset / new patients).
export function replan() {
  planFrom(clock.now());
}
