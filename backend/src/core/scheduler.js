// Job scheduler: persisted, idempotent, demo-clock aware.
//
//   defineJob(kind, { run, collapse, collapseKey })   // register a handler (done by feature modules)
//   schedule({ kind, patientId, dueAt, key, payload })  // idempotent by `key`
//   cancel(filter) / listJobs(filter)
//   tick() -> { ran, missed, failed }    // run everything due at clock.now()
//
// Jobs live in the store's `jobs` collection so a restart never loses or repeats
// them. `collapse: true` (recurring prompts like check-ins) means: when several
// occurrences are overdue at once, e.g. after the demo clock jumps 3 days, only the
// newest one runs and the older ones are marked 'missed'. Patients don't get
// three check-ins in a row, and the misses show up in signals like real ones.
import * as store from '../store.js';
import * as clock from './clock.js';

const handlers = new Map(); // kind -> { run(job), collapse, collapseKey(job)? }
let running = null;

// skipIf(job) -> reason string to skip (job is marked done with { skipped }), or falsy to run.
// retries: how many times a throwing run is retried (2 min, 4 min, ... later) before the job is
// marked failed for good. Only for handlers that are safe to run again after a partial attempt.
export function defineJob(kind, { run, collapse = false, collapseKey, skipIf, retries = 0, retryDelayMs = 2 * 60_000 }) {
  handlers.set(kind, { run, collapse, collapseKey, skipIf, retries, retryDelayMs });
}

// A crash mid-job leaves status 'running' in the saved file, and nothing ever picks it up again:
// that patient's check-in (and the silence ladder behind it) would be lost without a trace.
// Called once at boot, before the first tick. At-least-once beats never: check-in start is
// idempotent (collapse + "already in progress" guard). -> number recovered.
export function recoverInterrupted() {
  let n = 0;
  for (const j of jobs()) {
    if (j.status !== 'running') continue;
    j.status = 'pending';
    j.recoveredAt = clock.nowISO();
    store.audit('job_recovered', j.patientId, { kind: j.kind, jobId: j.id });
    n++;
  }
  if (n) store.persist('job', { recovered: n });
  return n;
}

const groupOf = (j) => `${j.kind}:${handlers.get(j.kind)?.collapseKey?.(j) ?? j.patientId}`;

const jobs = () => store.collection('jobs');

// Idempotent: a job with the same key is never created twice (in any status).
export function schedule({ kind, patientId = null, dueAt, key, payload = {} }) {
  if (!handlers.has(kind)) throw new Error(`schedule: unknown job kind "${kind}"`);
  const k = key ?? `${kind}:${patientId}:${dueAt}`;
  const existing = jobs().find((j) => j.key === k);
  if (existing) return existing;
  const job = {
    id: crypto.randomUUID(),
    key: k,
    kind,
    patientId,
    dueAt: new Date(dueAt).toISOString(),
    status: 'pending',
    payload,
    createdAt: clock.nowISO(),
  };
  jobs().push(job);
  store.persist('job', job);
  return job;
}

const matches = (j, f) => Object.entries(f).every(([k, v]) => (k === 'payload' ? true : j[k] === v));

export function listJobs(filter = {}) {
  return jobs().filter((j) => matches(j, filter)).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

// Cancel pending jobs matching the filter (e.g. the outreach ladder once the patient replies).
export function cancel(filter) {
  let n = 0;
  for (const j of jobs()) {
    if (j.status === 'pending' && matches(j, filter)) {
      j.status = 'cancelled';
      j.ranAt = clock.nowISO();
      n++;
    }
  }
  if (n) store.persist('job', { cancelled: n, filter });
  return n;
}

// Run every due job. Concurrent callers share the same in-flight run.
export function tick() {
  running ??= runDue().finally(() => (running = null));
  return running;
}

const MAX_JOBS_PER_TICK = 2000; // runaway guard

// Runs due jobs one at a time in dueAt order, re-reading the queue after each job: a job
// can schedule follow-ups that are already due during a demo-clock catch-up (a 09:00
// check-in schedules its 11:00 and 15:00 ladder rungs), and those must run before a 20:00
// reminder, not after it.
async function runDue() {
  const summary = { ran: 0, missed: 0, failed: 0 };
  for (let n = 0; n < MAX_JOBS_PER_TICK; n++) {
    const now = clock.now();
    const due = jobs()
      .filter((j) => j.status === 'pending' && Date.parse(j.dueAt) <= now)
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    if (!due.length) break;

    // Collapse overdue recurring jobs: keep only the newest per group
    // (default group = kind + patient; a kind can refine it, e.g. per med time slot).
    const newest = new Map();
    for (const j of due) {
      if (!handlers.get(j.kind)?.collapse) continue;
      const g = groupOf(j);
      if (!newest.has(g) || newest.get(g).dueAt < j.dueAt) newest.set(g, j);
    }
    let collapsed = false;
    for (const j of due) {
      if (handlers.get(j.kind)?.collapse && newest.get(groupOf(j)) !== j) {
        j.status = 'missed';
        j.ranAt = clock.nowISO();
        summary.missed++;
        collapsed = true;
      }
    }
    if (collapsed) continue; // re-read: the earliest due job may have changed

    {
      const j = due[0];
      const h = handlers.get(j.kind);
      j.status = 'running';
      try {
        if (!h) throw new Error(`no handler for "${j.kind}"`);
        if (j.patientId && !store.getPatient(j.patientId)) throw new Error(`patient ${j.patientId} not found`);
        const skip = h.skipIf?.(j);
        j.result = skip ? { skipped: skip } : ((await h.run(j)) ?? null);
        j.status = 'done';
        summary.ran++;
      } catch (err) {
        summary.failed++;
        j.attempts = (j.attempts ?? 0) + 1;
        store.audit('job_failed', j.patientId, { kind: j.kind, error: err.message, attempt: j.attempts });
        console.error(`[scheduler] ${j.kind} for ${j.patientId} failed (attempt ${j.attempts}):`, err.message);
        if (j.attempts <= (h?.retries ?? 0)) {
          // Try again later: back to pending, due after a growing delay, so one failed send
          // doesn't lose the day's check-in.
          j.status = 'pending';
          j.retryOf = j.dueAt;
          j.dueAt = new Date(clock.now() + h.retryDelayMs * j.attempts).toISOString();
          j.lastError = err.message;
          store.persist('job', { tick: summary });
          continue;
        }
        j.status = 'failed';
        j.error = err.message;
      }
      j.ranAt = clock.nowISO();
    }
    store.persist('job', { tick: summary });
  }
  return summary;
}

// Test hook
export function _handlers() {
  return handlers;
}
