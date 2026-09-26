// Tiny JSON-file store. Everything lives in memory and is flushed to data/db.json.
// Good enough for a hackathon demo; no native deps.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { buildSeed } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Emits 'change' with { type, payload } so socket.io can push live updates to the dashboard.
export const events = new EventEmitter();

let db = load();

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return buildSeed();
  }
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function emit(type, payload) {
  save();
  events.emit('change', { type, payload });
}

export function reset() {
  db = buildSeed();
  emit('reset', null);
}

// ---------- patients ----------
export const listPatients = () => db.patients;
export const getPatient = (id) => db.patients.find((p) => p.id === id);
export const getPatientByCode = (code) =>
  db.patients.find((p) => p.linkCode.toUpperCase() === String(code).toUpperCase());

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
export function addMessage({ patientId, direction, to = 'patient', text, textEn }) {
  const msg = { id: crypto.randomUUID(), ts: new Date().toISOString(), patientId, direction, to, text, textEn };
  db.messages.push(msg);
  emit('message', msg);
  return msg;
}
export const listMessages = (patientId) => db.messages.filter((m) => m.patientId === patientId);

// ---------- alerts ----------
export function addAlert({ patientId, tier, reasons }) {
  const alert = { id: crypto.randomUUID(), ts: new Date().toISOString(), patientId, tier, reasons, status: 'open' };
  db.alerts.unshift(alert);
  emit('alert', alert);
  return alert;
}
export const listAlerts = () => db.alerts;
export function updateAlert(id, patch) {
  const a = db.alerts.find((x) => x.id === id);
  if (!a) return null;
  Object.assign(a, patch);
  emit('alert', a);
  return a;
}

// Raw access for core modules that need it (checkin state, vitals, etc.)
export const raw = () => db;
export const persist = (type = 'update', payload = null) => emit(type, payload);
