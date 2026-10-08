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

// Default ("urgency"): tier (RED first) -> SLA deadline (soonest first) -> patient risk (highest
// first) -> newest. Other modes: 'newest', 'oldest', 'sla' (deadline only, ignoring tier).
export const SORTS = [
  ['urgency', 'Most urgent'],
  ['sla', 'Soonest deadline'],
  ['newest', 'Newest'],
  ['oldest', 'Oldest'],
];
export function sortWorklist(alerts, patientsById = {}, mode = 'urgency') {
  const risk = (a) => patientsById[a.patientId]?.riskScore ?? 0;
  const urgency = (a, b) =>
    (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) || dueMs(a) - dueMs(b) || risk(b) - risk(a) || Date.parse(b.ts) - Date.parse(a.ts);
  const by = {
    urgency,
    sla: (a, b) => dueMs(a) - dueMs(b) || urgency(a, b),
    newest: (a, b) => Date.parse(b.ts) - Date.parse(a.ts) || urgency(a, b),
    oldest: (a, b) => Date.parse(a.ts) - Date.parse(b.ts) || urgency(a, b),
  };
  return alerts.filter(isOpen).slice().sort(by[mode] ?? urgency);
}

const plain = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// kind / tier / status / assignee ('mine' = `me`, 'unassigned') and a free-text search across
// the patient's name, the alert title, reasons, assignee and kind. Every word of the query must match.
export function filterWorklist(items, { kind = 'all', tier = 'all', status = 'all', assignee = 'all', me = '', q = '', patientsById = {} } = {}) {
  const terms = plain(q).split(/\s+/).filter(Boolean);
  const mine = plain(me);
  return items.filter((a) => {
    if (kind !== 'all' && (a.kind ?? 'triage') !== kind) return false;
    if (tier !== 'all' && a.tier !== tier) return false;
    if (status !== 'all' && a.status !== status) return false;
    if (assignee === 'mine' && (!mine || plain(a.assignee) !== mine)) return false;
    if (assignee === 'unassigned' && a.assignee) return false;
    if (!terms.length) return true;
    const hay = plain([patientsById[a.patientId]?.name ?? a.patientId, a.title, ...(a.reasons ?? []), a.assignee, kindOf(a).label, a.kind].join(' '));
    return terms.every((t) => hay.includes(t));
  });
}

// The wallboard: what needs a nurse right now. Open alerts past their deadline, and ones due
// within `soonMs`. RED first, then most overdue / soonest. -> { overdue, soon, count }
export function dueSoon(alerts, now, { soonMs = 10 * 60_000 } = {}) {
  const open = alerts.filter(isOpen).filter((a) => Number.isFinite(Date.parse(a.dueBy)));
  const order = (a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) || dueMs(a) - dueMs(b);
  const overdue = open.filter((a) => dueMs(a) < now).sort(order);
  const soon = open.filter((a) => dueMs(a) >= now && dueMs(a) - now <= soonMs).sort(order);
  return { overdue, soon, count: overdue.length + soon.length };
}

// Patients who have stopped answering (signals.silentDays from the API), longest silence first.
export function silentPatients(patients, minDays = 2) {
  return (patients ?? [])
    .map((patient) => ({ patient, days: patient.signals?.silentDays }))
    .filter((x) => Number.isFinite(x.days) && x.days >= minDays)
    .sort((a, b) => b.days - a.days);
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
