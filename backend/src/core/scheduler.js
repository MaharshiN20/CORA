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

// key -> job, so planning (thousands of schedule() calls per pass) is not O(jobs) each time.
// Rebuilt whenever the underlying array is replaced (reset) or its length changed behind our
// back (prune, recovery), so it can't go stale in a way that creates duplicate jobs.
let keyIndex = { arr: null, size: -1, map: new Map() };
function byKey(k) {
  const arr = jobs();
  if (keyIndex.arr !== arr || keyIndex.size !== arr.length) {
    keyIndex = { arr, size: arr.length, map: new Map(arr.map((j) => [j.key, j])) };
  }
  return keyIndex.map.get(k);
}

// Idempotent: a job with the same key is never created twice (in any status).
export function schedule({ kind, patientId = null, dueAt, key, payload = {} }) {
  if (!handlers.has(kind)) throw new Error(`schedule: unknown job kind "${kind}"`);
  const k = key ?? `${kind}:${patientId}:${dueAt}`;
  const existing = byKey(k);
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
  keyIndex.map.set(k, job);
  keyIndex.size = jobs().length;
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

// Runs due jobs one at a time in dueAt order. A job can schedule follow-ups that are already due
// during a demo-clock catch-up (a 09:00 check-in schedules its 11:00 and 15:00 ladder rungs), and
// those must run before a 20:00 reminder, not after it, so jobs added while running are merged into
// the sorted due list. The due list is built once and kept: re-scanning and re-sorting every retained
// job after every job was O(jobs) each time (15k jobs after a 72 h jump at 500 patients: 9-16 s of
// blocked event loop, audit 2026-10-11). Overdue recurring jobs collapse to the newest per group.
async function runDue() {
  const summary = { ran: 0, missed: 0, failed: 0 };
  const byDue = (a, b) => a.dueAt.localeCompare(b.dueAt);
  const newest = new Map(); // collapse group -> the newest pending job of that group
  const markMissed = (j) => {
    j.status = 'missed';
    j.ranAt = clock.nowISO();
    summary.missed++;
  };
  // Returns the job to keep in the due list, or null when `j` was collapsed away.
  const admit = (j) => {
    if (!handlers.get(j.kind)?.collapse) return j;
    const g = groupOf(j);
    const prev = newest.get(g);
    if (!prev || prev.dueAt < j.dueAt) {
      if (prev) markMissed(prev);
      newest.set(g, j);
      return j;
    }
    markMissed(j);
    return null;
  };

  const now0 = clock.now();
  let seenLen = jobs().length;
  const due = [];
  for (const j of jobs().filter((x) => x.status === 'pending' && Date.parse(x.dueAt) <= now0).sort(byDue)) if (admit(j)) due.push(j);
  let head = 0;

  for (let n = 0; n < MAX_JOBS_PER_TICK; n++) {
    // Jobs scheduled since the last look (by the job that just ran): merge the ones already due.
    const all = jobs();
    if (all.length !== seenLen) {
      const now = clock.now();
      for (const j of all.slice(seenLen)) {
        if (j.status !== 'pending' || Date.parse(j.dueAt) > now || !admit(j)) continue;
        let lo = head;
        let hi = due.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (byDue(due[mid], j) <= 0) lo = mid + 1;
          else hi = mid;
        }
        due.splice(lo, 0, j);
      }
      seenLen = all.length;
    }
    while (head < due.length && due[head].status !== 'pending') head++; // collapsed after being listed
    if (head >= due.length) break;

    const j = due[head++];
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
    store.persist('job', { tick: summary });
  }
  return summary;
}

// Test hook
export function _handlers() {
  return handlers;
}
