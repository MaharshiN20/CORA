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
import { getSignals } from './signals.js';
import { occurrences, isMonitored, allPlanners } from './planning.js';
// Feature modules register their job kinds + planners on import.
import './meds.js';
import './pharmacy.js';
import './digest.js';
import './lessons.js';
import './sdoh.js';
import { startLadder } from './outreach.js';

const HORIZON_MS = 48 * clock.HOUR;
const TICK_MS = 30_000;
// A check-in started this long before the next scheduled one is stale (never finished).
const STALE_CHECKIN_MS = 12 * clock.HOUR;

// Check-in times by plan (local time). High risk (2/day) adds an evening check.
export const CHECKIN_TIMES = { 1: ['09:00'], 2: ['09:00', '19:00'] };

// ---------- job kinds ----------

scheduler.defineJob('checkin_due', {
  collapse: true,
  async run(job) {
    const p = store.getPatient(job.patientId);
    if (checkinActive(p)) {
      // Started recently (patient mid-answer): leave it alone.
      if (Date.parse(job.dueAt) - Date.parse(p.checkin.startedAt) < STALE_CHECKIN_MS) {
        return { skipped: 'checkin already in progress' };
      }
      // Yesterday's never-finished check-in: abandon it (keep what was answered) and ask fresh.
      store.audit('checkin_abandoned', p.id, { startedAt: p.checkin.startedAt, step: p.checkin.state, partial: p.checkin.answers });
      store.updatePatient(p.id, { checkin: { state: 'idle', answers: {} } });
    }
    const replies = await startCheckin(p.id);
    for (const r of replies) await channels.sendToPatient(p, r);
    // The ladder counts from when the check-in was *due*, not when this tick ran: after a
    // demo-clock jump the job runs at the end of the window, and counting from there pushed
    // the +2h reminder and +6h caregiver ping past the jump (a "+1 day" showed no escalation).
    // In live use the two are within one 30s tick of each other.
    startLadder(p, job.dueAt);
    store.audit('checkin_sent', p.id, { jobId: job.id, scheduledFor: job.dueAt });
    return { sent: replies.length };
  },
});

// ---------- planning ----------

// Re-exported so tests and callers have one import for planning.
export { atLocalTime, occurrences, isMonitored, addPlanner } from './planning.js';

export function planPatient(p, fromMs, toMs) {
  const { plan } = scoreRisk(p, getSignals(p)); // live tier (Risk v2): High risk -> 2 check-ins/day
  const times = CHECKIN_TIMES[plan.checkinsPerDay] ?? CHECKIN_TIMES[1];
  for (const { at, key } of occurrences(times, fromMs, toMs)) {
    if (!isMonitored(p, at)) continue;
    scheduler.schedule({ kind: 'checkin_due', patientId: p.id, dueAt: at, key: `checkin_due:${p.id}:${key}` });
  }
  for (const planner of allPlanners()) planner(p, fromMs, toMs);
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
