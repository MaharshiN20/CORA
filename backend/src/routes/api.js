// Core REST API for the nurse dashboard (Prannav lane). Mounted at /api.
// Shapes are documented in docs/CONTRACTS.md; the frontend (Maharshi) builds against them.
import { Router } from 'express';
import * as store from '../store.js';
import * as channels from '../channels/index.js';
import { handleInbound, startCheckin } from '../core/agent.js';
import { createPatient, languages } from '../core/enroll.js';
import { getSignals } from '../core/signals.js';
import { scoreRisk } from '../core/risk.js';
import { adherence } from '../core/meds.js';
import { markPickedUp } from '../core/pharmacy.js';
import { startLadder } from '../core/outreach.js';
import { sendNurseMessage, notifyAck } from '../core/nurse.js';
import { buildDigest, sendDigest } from '../core/digest.js';
import { startScreen } from '../core/sdoh.js';
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
// Risk is computed live on every read (Risk v2: baseline + today's signals), so the dashboard
// is never behind: a weight jump shows up before the patient's next check-in finishes.
function withLiveRisk(p) {
  const signals = getSignals(p);
  const live = scoreRisk(p, signals);
  return {
    ...p,
    signals,
    riskScore: live.score,
    riskTier: live.tier,
    riskFactors: live.factors,
    riskBaseline: live.baseline,
    riskDynamic: live.dynamic,
  };
}

api.get('/patients', (_req, res) => res.json(store.listPatients().map(withLiveRisk)));

api.get('/patients/:id', (req, res) => {
  const p = store.getPatient(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json({
    ...withLiveRisk(p),
    adherence: adherence(p),
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
// Acknowledging a patient-facing alert tells the patient a nurse has seen it (once).
api.patch('/alerts/:id', async (req, res) => {
  const { status, outcome, assignee, note, by } = req.body ?? {};
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES}` });
  if (outcome && !OUTCOMES.includes(outcome)) return res.status(400).json({ error: `outcome must be one of ${OUTCOMES}` });
  const patch = Object.fromEntries(Object.entries({ status, outcome, assignee, note, by }).filter(([, v]) => v !== undefined));
  const a = store.updateAlert(req.params.id, patch);
  if (!a) return res.status(404).json({ error: 'not found' });
  store.audit('nurse_action', a.patientId, { alertId: a.id, ...patch });
  if (status === 'acknowledged') await notifyAck(a, by ?? assignee);
  if (status === 'resolved' && outcome === 'false_positive' && (a.kind ?? 'triage') === 'triage') clearFalseAlarmTier(a);
  res.json(store.getAlert(a.id));
});

// A nurse marked a triage alert a false alarm: the patient list shouldn't keep showing that
// tier. lastTier becomes the highest tier among their other open triage alerts, else GREEN.
function clearFalseAlarmTier(alert) {
  const p = store.getPatient(alert.patientId);
  if (!p || p.lastTier !== alert.tier) return;
  const open = store.listAlerts().filter((x) => x.patientId === p.id && x.id !== alert.id && (x.kind ?? 'triage') === 'triage' && x.status !== 'resolved');
  const lastTier = open.some((x) => x.tier === 'RED') ? 'RED' : open.some((x) => x.tier === 'YELLOW') ? 'YELLOW' : 'GREEN';
  store.updatePatient(p.id, { lastTier });
  store.audit('tier_cleared', p.id, { alertId: alert.id, from: alert.tier, to: lastTier, reason: 'false_positive' });
}

// POST /api/patients/:id/message { text } | { template: 'call_scheduled', time } (+ from?)
// Nurse -> patient via their channel, translated to the patient's language.
api.post('/patients/:id/message', async (req, res) => {
  try {
    res.json(await sendNurseMessage(req.params.id, req.body ?? {}));
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ---- caregiver digest ----

// GET /api/patients/:id/digest?lang= -> { text } preview (no sending)
api.get('/patients/:id/digest', (req, res) => {
  const p = store.getPatient(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json({ text: buildDigest(p, req.query.lang || p.caregiver?.language || 'en') });
});

// POST /api/patients/:id/digest -> send the weekly digest to the caregiver now (demo button)
api.post('/patients/:id/digest', async (req, res) => {
  try {
    res.json(await sendDigest(req.params.id));
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ---- social-needs screen ----

// POST /api/patients/:id/sdoh/start -> send the 4-question social-needs screen now (demo button)
api.post('/patients/:id/sdoh/start', async (req, res) => {
  try {
    const p = store.getPatient(req.params.id);
    const replies = await startScreen(req.params.id);
    for (const r of replies) await channels.sendToPatient(store.getPatient(p.id), r);
    res.json({ sent: replies.length });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ---- pharmacy ----

// POST /api/patients/:id/prescriptions/:med/picked-up { by? } -> updated prescription
// Stand-in for a pharmacy fill feed; also the dashboard's "mark picked up" button.
api.post('/patients/:id/prescriptions/:med/picked-up', (req, res) => {
  if (!store.getPatient(req.params.id)) return res.status(404).json({ error: 'patient not found' });
  const rx = markPickedUp(req.params.id, req.params.med, { by: req.body?.by ?? 'dashboard' });
  if (!rx) return res.status(404).json({ error: 'prescription not found' });
  res.json(rx);
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
  startLadder(p, store.getPatient(p.id).checkin.startedAt); // silence after this escalates
  res.json({ sent: replies.length });
});

// Pretend to be the patient (or caregiver) without Telegram: backend dev + demo backup.
// { text?, buttonData?, role?, photo? }
api.post('/patients/:id/simulate', async (req, res) => {
  const { text, buttonData, role, photo } = req.body ?? {};
  if (!store.getPatient(req.params.id)) return res.status(404).json({ error: 'not found' });
  if (!text?.trim() && !buttonData && !photo) return res.status(400).json({ error: 'text, buttonData or photo is required' });
  const replies = await handleInbound({ patientId: req.params.id, text, buttonData, role, photo, channel: 'sim' });
  res.json(replies);
});

// Kept for the current dashboard; the demo console uses /api/demo/reset.
api.post('/reset', (_req, res) => {
  store.reset();
  res.json({ ok: true });
});
