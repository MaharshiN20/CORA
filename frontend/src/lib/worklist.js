// Nurse worklist logic, kept out of components so it's unit-tested (worklist.test.js).
// Alert shape: docs/CONTRACTS.md §3 (alerts collection).

export const TIER_RANK = { RED: 0, YELLOW: 1, INFO: 2 };

export const KINDS = {
  triage: { label: 'Triage', icon: '🩺' },
  unreachable: { label: 'Unreachable', icon: '📵' },
  refill: { label: 'Refill', icon: '💊' },
  sdoh: { label: 'Social need', icon: '🏠' },
  question: { label: 'Question', icon: '❓' },
  med_discrepancy: { label: 'Med discrepancy', icon: '⚠️' },
  device: { label: 'Device', icon: '📟' },
};
export const kindOf = (alert) => KINDS[alert.kind ?? 'triage'] ?? { label: alert.kind, icon: '•' };

export const isOpen = (alert) => alert.status !== 'resolved';

const dueMs = (a) => {
  const t = Date.parse(a.dueBy);
  return Number.isFinite(t) ? t : Infinity; // no SLA -> after everything that has one
};

// Tier (RED first) -> SLA deadline (soonest first) -> patient risk (highest first) -> newest.
export function sortWorklist(alerts, patientsById = {}) {
  const risk = (a) => patientsById[a.patientId]?.riskScore ?? 0;
  return alerts
    .filter(isOpen)
    .slice()
    .sort(
      (a, b) =>
        (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) ||
        dueMs(a) - dueMs(b) ||
        risk(b) - risk(a) ||
        Date.parse(b.ts) - Date.parse(a.ts),
    );
}

export function filterWorklist(items, { kind = 'all', tier = 'all' } = {}) {
  return items.filter((a) => (kind === 'all' || (a.kind ?? 'triage') === kind) && (tier === 'all' || a.tier === tier));
}

export function formatDuration(ms) {
  const m = Math.floor(Math.abs(ms) / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// SLA countdown for an alert at time `now` (ms). Resolved or no dueBy -> null.
export function sla(alert, now) {
  if (!isOpen(alert)) return null;
  const due = Date.parse(alert.dueBy);
  if (!Number.isFinite(due)) return null;
  const remainingMs = due - now;
  const overdue = remainingMs < 0;
  return { remainingMs, overdue, label: overdue ? `Overdue ${formatDuration(remainingMs)}` : `${formatDuration(remainingMs)} left` };
}

// open -> acknowledged -> contacted -> resolved (resolving needs an outcome).
const FLOW = {
  open: { status: 'acknowledged', label: 'Acknowledge' },
  acknowledged: { status: 'contacted', label: 'Mark contacted' },
  contacted: { status: 'resolved', label: 'Resolve…' },
};
export const nextAction = (alert) => FLOW[alert.status] ?? null;

export const OUTCOMES = [
  { value: 'true_positive', label: 'Real problem, handled' },
  { value: 'ed_avoided', label: 'ER visit avoided' },
  { value: 'false_positive', label: 'False alarm' },
  { value: 'readmitted', label: 'Readmitted' },
  { value: 'other', label: 'Other' },
];

// Body for PATCH /api/alerts/:id when resolving. Throws if the outcome is missing/unknown.
export function resolvePatch(outcome, note, by = 'nurse') {
  if (!OUTCOMES.some((o) => o.value === outcome)) throw new Error('Pick an outcome to resolve');
  return { status: 'resolved', outcome, by, ...(note?.trim() && { note: note.trim() }) };
}
