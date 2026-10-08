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

const BAK_FILE = `${DB_FILE}.bak`;
const TMP_FILE = `${DB_FILE}.tmp`;
const SAVE_DEBOUNCE_MS = 250; // a burst of mutations (one inbound message makes many) is one write
const BACKUP_EVERY_MS = 30_000;

let db = load();

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Only a genuinely missing file means "first run, seed the demo". A file that exists but won't
// parse (a crash mid-write on an older build, disk trouble) is never silently replaced by seed
// data, which the next save would then write over the only copy: recover from the last good .bak,
// or refuse to start so a human can look.
function load() {
  let data;
  try {
    data = readJson(DB_FILE);
  } catch (err) {
    if (err.code === 'ENOENT') {
      data = buildSeed();
    } else {
      try {
        fs.copyFileSync(DB_FILE, `${DB_FILE}.corrupt`);
      } catch {}
      try {
        data = readJson(BAK_FILE);
        console.error(`[store] ${DB_FILE} was unreadable (${err.message}); recovered from ${BAK_FILE}`);
        fs.unlinkSync(DB_FILE); // keep the bad copy out of the .bak rotation
      } catch {
        throw new Error(`[store] ${DB_FILE} is corrupt (${err.message}) and there is no usable backup. Copy kept at ${DB_FILE}.corrupt; fix or delete it to start fresh.`);
      }
    }
  }
  for (const c of DEFAULT_COLLECTIONS) data[c] ??= [];
  clock.setOffset(data.clockOffsetMs ?? 0);
  return data;
}

// Write-then-rename so a crash leaves either the old file or the new one, never half of one.
// The previous file is copied to .bak (at most every 30 s) before it is replaced.
let lastBackup = -Infinity;
function writeNow() {
  db.clockOffsetMs = clock.offset();
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const fd = fs.openSync(TMP_FILE, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(db));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const t = performance.now(); // monotonic: this is I/O pacing, not domain time (core/clock.js)
  if (t - lastBackup >= BACKUP_EVERY_MS && fs.existsSync(DB_FILE)) {
    fs.copyFileSync(DB_FILE, BAK_FILE);
    lastBackup = t;
  }
  fs.renameSync(TMP_FILE, DB_FILE);
}

let saveTimer = null;
function save() {
  db.clockOffsetMs = clock.offset(); // in-memory state stays current; only the disk write is deferred
  if (saveTimer) return;
  saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  saveTimer.unref(); // never keeps the process (or a test run) alive
}

// Write any pending changes now. Also runs on process exit; index.js calls it on SIGTERM/SIGINT.
export function flush() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  writeNow();
}
process.on('exit', () => {
  if (saveTimer) flush();
});

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

// Put one seeded patient back to their seed state (scripted demo scenarios replay cleanly)
// without touching anyone else. Their messages, alerts, audit and readings go too. Chat/phone
// links are kept so a judge's phone stays connected. -> the fresh patient, or null.
export function resetPatient(id) {
  const fresh = buildSeed().patients.find((p) => p.id === id);
  const i = db.patients.findIndex((p) => p.id === id);
  if (!fresh || i < 0) return null;
  const cur = db.patients[i];
  fresh.chatId = cur.chatId ?? null;
  if (cur.phone) Object.assign(fresh, { phone: cur.phone, channel: cur.channel });
  fresh.caregiver = { ...fresh.caregiver, chatId: cur.caregiver?.chatId ?? null, ...(cur.caregiver?.phone && { phone: cur.caregiver.phone, channel: cur.caregiver.channel }) };
  db.patients[i] = fresh;
  for (const c of ['messages', 'alerts', 'audit', 'readings']) db[c] = db[c].filter((x) => x.patientId !== id);
  emit('patient', fresh);
  return fresh;
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
  if (chatId == null) return null; // unlinked patients have chatId null: null must not "match" them
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

// ---------- retention ----------
// Everything is in memory and rewritten on each flush, so unbounded logs slow every request and
// every save. Oldest-first caps keep that bounded; they are far above a demo's or a pilot's
// volume. Done/missed/cancelled jobs are only history once a week has passed.
export const RETENTION = { jobDays: 7, audit: 20_000, messages: 20_000, readings: 20_000 };

// Drop from the front (oldest first) in place, so arrays handed out earlier stay valid.
function dropOldest(arr, max) {
  if (arr.length <= max) return 0;
  const n = arr.length - max;
  arr.splice(0, n);
  return n;
}

export function prune() {
  const cutoff = clock.now() - RETENTION.jobDays * 24 * 60 * 60 * 1000;
  const jobs = db.jobs;
  let kept = 0;
  let removed = 0;
  for (const j of jobs) {
    const history = j.status === 'done' || j.status === 'missed' || j.status === 'cancelled';
    if (history && Date.parse(j.ranAt ?? j.dueAt) < cutoff) removed++;
    else jobs[kept++] = j;
  }
  jobs.length = kept;
  removed += dropOldest(db.audit, RETENTION.audit);
  removed += dropOldest(db.messages, RETENTION.messages);
  removed += dropOldest(db.readings, RETENTION.readings);
  if (removed) save(); // quiet: nothing changed that a dashboard shows
  return removed;
}

// Raw access for core modules that need it (checkin state, vitals, etc.)
export const raw = () => db;
export const persist = (type = 'update', payload = null) => emit(type, payload);
