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

export function defineJob(kind, { run, collapse = false, collapseKey }) {
  handlers.set(kind, { run, collapse, collapseKey });
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

async function runDue() {
  const summary = { ran: 0, missed: 0, failed: 0 };
  // Loop: handlers may schedule follow-ups that are already due (e.g. catch-up after a jump).
  for (let pass = 0; pass < 10; pass++) {
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

    for (const j of due) {
      const h = handlers.get(j.kind);
      if (h?.collapse && newest.get(groupOf(j)) !== j) {
        j.status = 'missed';
        j.ranAt = clock.nowISO();
        summary.missed++;
        continue;
      }
      j.status = 'running';
      try {
        if (!h) throw new Error(`no handler for "${j.kind}"`);
        if (j.patientId && !store.getPatient(j.patientId)) throw new Error(`patient ${j.patientId} not found`);
        j.result = (await h.run(j)) ?? null;
        j.status = 'done';
        summary.ran++;
      } catch (err) {
        j.status = 'failed';
        j.error = err.message;
        summary.failed++;
        store.audit('job_failed', j.patientId, { kind: j.kind, error: err.message });
        console.error(`[scheduler] ${j.kind} for ${j.patientId} failed:`, err.message);
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
