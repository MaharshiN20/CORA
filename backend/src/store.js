// Tiny JSON-file store. Everything lives in memory and is flushed to data/db.json.
// No native deps. The exported API is the contract (docs/CONTRACTS.md): callers
// never touch the file, so this can be swapped for SQLite later without changes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { buildSeed } from './seed.js';
import * as clock from './core/clock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = process.env.HEARTBRIDGE_DB || path.join(DATA_DIR, 'db.json');

// Collections every db has. Older db.json files get missing ones added on load.
const DEFAULT_COLLECTIONS = ['patients', 'messages', 'alerts', 'audit', 'readings', 'jobs'];

// Emits 'change' with { type, payload } so socket.io can push live updates to the dashboard.
export const events = new EventEmitter();

let db = load();

function load() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    data = buildSeed();
  }
  for (const c of DEFAULT_COLLECTIONS) data[c] ??= [];
  clock.setOffset(data.clockOffsetMs ?? 0);
  return data;
}

function save() {
  db.clockOffsetMs = clock.offset();
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function emit(type, payload) {
  save();
  events.emit('change', { type, payload });
}

// Persist the demo clock whenever it moves.
clock.clockEvents.on('advance', (e) => emit('clock', e));

export function reset() {
  clock.reset();
  db = buildSeed();
  for (const c of DEFAULT_COLLECTIONS) db[c] ??= [];
  emit('reset', null);
}

const newId = () => crypto.randomUUID();

// ---------- patients ----------
export const listPatients = () => db.patients;
export const getPatient = (id) => db.patients.find((p) => p.id === id);
export const getPatientByCode = (code) =>
  db.patients.find((p) => p.linkCode.toUpperCase() === String(code).toUpperCase());

export function addPatient(patient) {
  db.patients.push(patient);
  emit('patient', patient);
  return patient;
}

export function updatePatient(id, patch) {
  const p = getPatient(id);
  if (!p) return null;
  Object.assign(p, patch);
  emit('patient', p);
  return p;
}

// ---------- Telegram chat linking ----------
// code "GARCIA1"    -> links chat as the patient
// code "CG_GARCIA1" -> links chat as the patient's caregiver
export function linkChat(code, chatId) {
  const raw = String(code || '').trim().toUpperCase();
  const isCaregiver = raw.startsWith('CG_');
  const patient = getPatientByCode(isCaregiver ? raw.slice(3) : raw);
  if (!patient) return null;
  if (isCaregiver) patient.caregiver.chatId = chatId;
  else patient.chatId = chatId;
  emit('patient', patient);
  return { role: isCaregiver ? 'caregiver' : 'patient', patient };
}

// Returns { role, patient } for a Telegram chat id, or null if not linked.
export function findByChatId(chatId) {
  for (const p of db.patients) {
    if (p.chatId === chatId) return { role: 'patient', patient: p };
    if (p.caregiver?.chatId === chatId) return { role: 'caregiver', patient: p };
  }
  return null;
}

// ---------- messages (conversation log shown on dashboard) ----------
// direction: 'in' | 'out'; to: 'patient' | 'caregiver' | 'nurse'; from (inbound): 'patient' | 'caregiver'
export function addMessage({ patientId, direction, to = 'patient', from, text, textEn, buttons, channel }) {
  const msg = { id: newId(), ts: clock.nowISO(), patientId, direction, to, from, text, textEn, buttons, channel };
  db.messages.push(msg);
  emit('message', msg);
  return msg;
}
export function updateMessage(id, patch) {
  const m = db.messages.find((x) => x.id === id);
  if (!m) return null;
  Object.assign(m, patch);
  emit('message', m);
  return m;
}
export const listMessages = (patientId) => db.messages.filter((m) => m.patientId === patientId);

// ---------- alerts = the nurse worklist ----------
// kind:   'triage' | 'unreachable' | 'refill' | 'sdoh' | 'question' | 'med_discrepancy' | 'device'
// tier:   'RED' | 'YELLOW' | 'INFO'
// status: 'open' -> 'acknowledged' -> 'contacted' -> 'resolved'
// outcome (on resolve): 'true_positive' | 'false_positive' | 'ed_avoided' | 'readmitted' | 'other'
export const SLA_MS = { RED: 15 * 60 * 1000, YELLOW: 4 * clock.HOUR, INFO: 24 * clock.HOUR };

export function addAlert({ patientId, tier, reasons, kind = 'triage', title, ...extra }) {
  const ts = clock.now();
  const alert = {
    id: newId(),
    ts: new Date(ts).toISOString(),
    patientId,
    kind,
    tier,
    title: title ?? (reasons?.[0] || kind),
    reasons: reasons ?? [],
    status: 'open',
    dueBy: new Date(ts + (SLA_MS[tier] ?? SLA_MS.INFO)).toISOString(),
    assignee: null,
    outcome: null,
    history: [{ ts: new Date(ts).toISOString(), status: 'open' }],
    ...extra,
  };
  db.alerts.unshift(alert);
  emit('alert', alert);
  return alert;
}

// Non-clinical worklist item (refill barrier, SDOH need, unanswered question, ...).
export const addTask = ({ patientId, kind, title, reasons = [], tier = 'INFO', ...extra }) =>
  addAlert({ patientId, kind, title, reasons, tier, ...extra });

export const listAlerts = () => db.alerts;
export const getAlert = (id) => db.alerts.find((x) => x.id === id);

export function updateAlert(id, patch) {
  const a = getAlert(id);
  if (!a) return null;
  if (patch.status && patch.status !== a.status) {
    a.history = [...(a.history ?? []), { ts: clock.nowISO(), status: patch.status, by: patch.by ?? null }];
  }
  const { by, ...rest } = patch;
  Object.assign(a, rest);
  emit('alert', a);
  return a;
}

// ---------- audit trail: every clinical decision + action, for the "why" view ----------
// type examples: 'triage', 'escalation', 'outreach', 'nurse_action', 'refill_nudge', 'llm_parse'
export function audit(type, patientId, data = {}) {
  const entry = { id: newId(), ts: clock.nowISO(), type, patientId, data };
  db.audit.push(entry);
  emit('audit', entry);
  return entry;
}
export const listAudit = (patientId) => (patientId ? db.audit.filter((e) => e.patientId === patientId) : db.audit);

// ---------- readings: weight / SpO2 / heart rate from self-report or devices ----------
// type: 'weight' (lb) | 'spo2' (%) | 'hr' (bpm); source: 'self' | 'device' | 'caregiver'
export function addReading({ patientId, type, value, source = 'self', device, ts }) {
  const r = { id: newId(), ts: ts ?? clock.nowISO(), patientId, type, value, source, device };
  db.readings.push(r);
  emit('reading', r);
  return r;
}
export const listReadings = (patientId, type) =>
  db.readings.filter((r) => r.patientId === patientId && (!type || r.type === type));

// ---------- generic collections for lane-owned data (e.g. insights cohort, jobs) ----------
// Returns the live array; call persist() after mutating it.
export function collection(name) {
  db[name] ??= [];
  return db[name];
}

// Raw access for core modules that need it (checkin state, vitals, etc.)
export const raw = () => db;
export const persist = (type = 'update', payload = null) => emit(type, payload);
