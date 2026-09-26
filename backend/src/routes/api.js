// Core REST API for the nurse dashboard (Prannav lane). Mounted at /api.
// Shapes are documented in docs/CONTRACTS.md; the frontend (Maharshi) builds against them.
import { Router } from 'express';
import * as store from '../store.js';
import * as channels from '../channels/index.js';
import { handleInbound, startCheckin } from '../core/agent.js';
import { createPatient, languages } from '../core/enroll.js';
import { getSignals } from '../core/signals.js';
import * as llm from '../core/llm/index.js';
import * as clock from '../core/clock.js';

export const api = Router();

api.get('/health', (_req, res) =>
  res.json({
    ok: true,
    telegram: !!process.env.TELEGRAM_BOT_TOKEN,
    llm: llm.status(),
    now: clock.nowISO(),
    demoOffsetMs: clock.offset(),
  }),
);

api.get('/languages', (_req, res) => res.json(languages()));

// ---- patients ----
api.get('/patients', (_req, res) => res.json(store.listPatients().map((p) => ({ ...p, signals: getSignals(p) }))));

api.get('/patients/:id', (req, res) => {
  const p = store.getPatient(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json({
    ...p,
    signals: getSignals(p),
    messages: store.listMessages(p.id),
    alerts: store.listAlerts().filter((a) => a.patientId === p.id),
    readings: store.listReadings(p.id),
    audit: store.listAudit(p.id),
  });
});

// POST /api/patients { name, age?, language?, profile?, meds?, ... } -> created patient
api.post('/patients', (req, res) => {
  try {
    res.status(201).json(createPatient(req.body ?? {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- nurse worklist (alerts + tasks) ----
api.get('/alerts', (_req, res) => res.json(store.listAlerts()));

const STATUSES = ['open', 'acknowledged', 'contacted', 'resolved'];
const OUTCOMES = ['true_positive', 'false_positive', 'ed_avoided', 'readmitted', 'other'];

// PATCH /api/alerts/:id { status?, outcome?, assignee?, note?, by? }
api.patch('/alerts/:id', (req, res) => {
  const { status, outcome, assignee, note, by } = req.body ?? {};
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES}` });
  if (outcome && !OUTCOMES.includes(outcome)) return res.status(400).json({ error: `outcome must be one of ${OUTCOMES}` });
  const patch = Object.fromEntries(Object.entries({ status, outcome, assignee, note, by }).filter(([, v]) => v !== undefined));
  const a = store.updateAlert(req.params.id, patch);
  if (!a) return res.status(404).json({ error: 'not found' });
  store.audit('nurse_action', a.patientId, { alertId: a.id, ...patch });
  res.json(a);
});

// ---- device readings (virtual scale / pulse-ox, later Withings) ----
const READING_TYPES = { weight: [50, 700], spo2: [50, 100], hr: [20, 250] };

// POST /api/devices/readings { patientId, type: 'weight'|'spo2'|'hr', value, device?, ts? } -> reading
// TODO(core P3-14): run triage on device readings (RED on SpO2 < 90, weight trend, ...).
api.post('/devices/readings', (req, res) => {
  const { patientId, type, value, device, ts } = req.body ?? {};
  if (!store.getPatient(patientId)) return res.status(404).json({ error: 'unknown patientId' });
  const range = READING_TYPES[type];
  if (!range) return res.status(400).json({ error: `type must be one of ${Object.keys(READING_TYPES)}` });
  const v = Number(value);
  if (!Number.isFinite(v) || v < range[0] || v > range[1]) return res.status(400).json({ error: `value out of range ${range}` });
  const reading = store.addReading({ patientId, type, value: v, source: 'device', device: device ?? 'unknown', ts });
  store.audit('device_reading', patientId, { type, value: v, device: reading.device });
  res.status(201).json(reading);
});

// ---- demo / simulation ----

// Kick off a check-in for a patient right now (normally done by the scheduler).
api.post('/patients/:id/checkin', async (req, res) => {
  const p = store.getPatient(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const replies = await startCheckin(p.id);
  for (const r of replies) await channels.sendToPatient(p, r);
  res.json({ sent: replies.length });
});

// Pretend to be the patient (or caregiver) without Telegram: backend dev + demo backup.
// { text?, buttonData?, role?, photo? }
api.post('/patients/:id/simulate', async (req, res) => {
  const { text, buttonData, role, photo } = req.body ?? {};
  if (!store.getPatient(req.params.id)) return res.status(404).json({ error: 'not found' });
  const replies = await handleInbound({ patientId: req.params.id, text, buttonData, role, photo, channel: 'sim' });
  res.json(replies);
});

// Kept for the current dashboard; the demo console uses /api/demo/reset.
api.post('/reset', (_req, res) => {
  store.reset();
  res.json({ ok: true });
});
