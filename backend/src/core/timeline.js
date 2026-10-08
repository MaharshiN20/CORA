// One patient's story on a single axis (check-ins, messages, alerts, readings, risk, key events),
// plus the audit log as CSV. Read-only: nothing here changes data.
import * as store from '../store.js';
import { riskHistory } from '../insights/riskHistory.js';

export const TIMELINE_KINDS = ['checkin', 'message', 'alert', 'reading', 'risk', 'event'];

// Audit rows worth a line in a patient's story. Everything else (parse traces, LLM traces, red-lock
// echoes, raw device rows, job noise) stays in the debug drawer.
const EVENT_TYPES = new Set([
  'nurse_action', 'nurse_message', 'nurse_ack_notice', 'escalation', 'protocol_applied', 'enroll', 'channel_link', 'channel_unlink',
  'link_refused', 'delivery_failed', 'delivery_dead', 'delivery_recovered', 'checkin_sent', 'checkin_abandoned', 'outreach',
  'outreach_recovered', 'med_reminder', 'med_response', 'refill_nudge', 'refill_barrier', 'refill_picked_up', 'sdoh', 'digest',
  'ai_review', 'tier_cleared', 'vital_reported', 'stale_tap_emergency', 'photo_received',
]);

const brief = (v) => (typeof v === 'string' ? v.slice(0, 80) : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null);

// "nurse action: status acknowledged, by Ana" from the first few simple fields of a row.
export function summarize(e) {
  const parts = Object.entries(e.data ?? {})
    .map(([k, v]) => [k, brief(v)])
    .filter(([, v]) => v)
    .slice(0, 4)
    .map(([k, v]) => `${k} ${v}`);
  return `${e.type.replace(/_/g, ' ')}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

// -> items newest first: { ts, kind, ... } (shape per kind below).
export function timeline(patient, { limit = 200, kinds = TIMELINE_KINDS } = {}) {
  const want = new Set(kinds);
  const items = [];
  if (want.has('checkin')) {
    for (const c of patient.checkins ?? []) {
      items.push({ ts: c.ts, kind: 'checkin', tier: c.tier, flags: (c.flags ?? []).map((f) => f.text), weight: c.answers?.weightLb ?? null, reporter: c.reporter ?? 'patient' });
    }
  }
  if (want.has('message')) {
    for (const m of store.listMessages(patient.id)) {
      items.push({ ts: m.ts, kind: 'message', direction: m.direction, to: m.to, from: m.from ?? null, text: m.text, textEn: m.textEn ?? null, delivery: m.delivery ?? null });
    }
  }
  if (want.has('alert')) {
    for (const a of store.listAlerts(patient.id)) {
      items.push({ ts: a.ts, kind: 'alert', alertId: a.id, tier: a.tier, title: a.title, status: a.status, source: a.source ?? null, alertKind: a.kind ?? 'triage' });
    }
  }
  if (want.has('reading')) {
    for (const r of store.listReadings(patient.id)) items.push({ ts: r.ts, kind: 'reading', type: r.type, value: r.value, source: r.source });
  }
  if (want.has('risk')) {
    for (const r of riskHistory(patient.id)) items.push({ ts: r.ts, kind: 'risk', score: r.score, tier: r.tier });
  }
  if (want.has('event')) {
    for (const e of store.listAudit(patient.id)) {
      if (EVENT_TYPES.has(e.type)) items.push({ ts: e.ts, kind: 'event', type: e.type, summary: summarize(e) });
    }
  }
  return items.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, limit);
}

// ---------- CSV ----------
// A cell is quoted when it needs it, and a leading = + - @ (or tab/CR) gets a ' in front so a
// spreadsheet reads it as text and never as a formula (CSV injection).
export function csvCell(value) {
  if (value == null) return '';
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s.startsWith("'") ? `"${s.replace(/"/g, '""')}"` : s;
}

// filter: { patientId?, type?, from?, to?, limit? } -> CSV text (CRLF rows, header first)
export function auditCsv({ patientId, type, from, to, limit = 5000 } = {}) {
  const names = new Map(store.listPatients().map((p) => [p.id, p.name]));
  const fromMs = from ? Date.parse(from) : -Infinity;
  const toMs = to ? Date.parse(to) : Infinity;
  const rows = store
    .listAudit(patientId || undefined)
    .filter((e) => (!type || e.type === type) && Date.parse(e.ts) >= fromMs && Date.parse(e.ts) <= toMs)
    .slice(-limit);
  const lines = [['ts', 'type', 'patientId', 'patientName', 'details']];
  for (const e of rows) lines.push([e.ts, e.type, e.patientId ?? '', names.get(e.patientId) ?? '', e.data ?? '']);
  return `${lines.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
