// Nurse worklist logic, kept out of components so it's unit-tested (worklist.test.js).
// Alert shape: docs/CONTRACTS.md §3 (alerts collection).
import { Stethoscope, PhoneOff, Pill, House, CircleHelp, TriangleAlert, Activity, ClipboardCheck } from 'lucide-react';
import { languageName } from './format.js';

export const TIER_RANK = { RED: 0, YELLOW: 1, INFO: 2 };

// icon: plain text for <option>s; Icon: the badge icon (one consistent set).
export const KINDS = {
  triage: { label: 'Triage', icon: '🩺', Icon: Stethoscope },
  unreachable: { label: 'Unreachable', icon: '📵', Icon: PhoneOff },
  refill: { label: 'Refill', icon: '💊', Icon: Pill },
  sdoh: { label: 'Social need', icon: '🏠', Icon: House },
  question: { label: 'Question', icon: '❓', Icon: CircleHelp },
  med_discrepancy: { label: 'Med discrepancy', icon: '⚠️', Icon: TriangleAlert },
  device: { label: 'Device', icon: '📟', Icon: Activity },
  protocol_followup: { label: 'Follow-up', icon: '📋', Icon: ClipboardCheck },
};
export const kindOf = (alert) => KINDS[alert.kind ?? 'triage'] ?? { label: alert.kind, icon: '•' };

export const isOpen = (alert) => alert.status !== 'resolved';

// A refetch returns brand-new objects for every alert, so memoised cards would re-render on every
// socket event. `memo` (a Map kept in a ref) remembers each alert's last JSON and object: an alert
// that did not change comes back as the same object. Alerts that are gone are forgotten.
export function stabilize(memo, list) {
  const out = [];
  const seen = new Set();
  for (const a of list ?? []) {
    const json = JSON.stringify(a);
    const prev = memo.get(a.id);
    const keep = prev && prev.json === json ? prev.obj : a;
    memo.set(a.id, { json, obj: keep });
    seen.add(a.id);
    out.push(keep);
  }
  for (const id of [...memo.keys()]) if (!seen.has(id)) memo.delete(id);
  return out;
}

// The AI reviewer's brief for the nurse. The API puts these fields directly on the alert
// (docs/CONTRACTS.md §3, backend/test/alerts.contract.test.js); there is no nested `ai` object.
// -> null when the alert has no AI brief.
export function aiOf(alert) {
  if (!alert?.nurseSummary && !alert?.suggestedActions?.length) return null;
  return {
    nurseSummary: alert.nurseSummary ?? null,
    suggestedActions: Array.isArray(alert.suggestedActions) ? alert.suggestedActions : [],
    readmissionRisk: alert.readmissionRisk ?? null,
    model: alert.model ?? null,
  };
}

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

// What actually happened to a nurse message (the API says; the UI must not claim more).
export function messageOutcome({ delivered, translated, language } = {}) {
  const notes = [];
  if (translated === false) notes.push(`⚠ sent in English: no translator for ${languageName(language)} right now`);
  if (!delivered) notes.push('logged in the chat; patient not on Telegram/SMS yet');
  return notes.length ? { tone: 'warn', text: notes.join(' · ') } : { tone: 'ok', text: translated ? `Sent ✓ (translated to ${languageName(language)})` : 'Sent ✓' };
}
