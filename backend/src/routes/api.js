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
import { sendNurseMessage, notifyAck, notifyAckMany } from '../core/nurse.js';
import { buildDigest, sendDigest } from '../core/digest.js';
import { startScreen } from '../core/sdoh.js';
import * as llm from '../core/llm/index.js';
import * as clock from '../core/clock.js';
import * as protocols from '../core/protocols.js';
import { ingestReading } from '../core/devicetriage.js';
import { timeline, auditCsv, TIMELINE_KINDS } from '../core/timeline.js';
import { riskHistory } from '../insights/riskHistory.js';
import { readiness } from '../readiness.js';

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

// GET /api/ready -> { ready, checks: { store, scheduler, telegram, twilio, llm, nurseChannel, outbox } }
// For load balancers and monitors: 503 when the store can't be written (src/readiness.js).
api.get('/ready', (_req, res) => {
  const state = readiness();
  res.status(state.ready ? 200 : 503).json(state);
});

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
    alerts: store.listAlerts(p.id),
    readings: store.listReadings(p.id),
    audit: store.listAudit(p.id),
  });
});

// GET /api/patients/:id/risk-history -> [{ ts, score, tier }] oldest first (last 200)
api.get('/patients/:id/risk-history', (req, res) => {
  if (!store.getPatient(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json(riskHistory(req.params.id).slice(-200));
});

// GET /api/patients/:id/timeline?limit=200&kinds=checkin,message,alert,reading,risk,event
// -> the patient's whole story on one axis, newest first (core/timeline.js)
api.get('/patients/:id/timeline', (req, res) => {
  const p = store.getPatient(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const limit = Math.min(1000, Math.max(1, Number.parseInt(req.query.limit, 10) || 200));
  const kinds = String(req.query.kinds ?? '').split(',').filter((k) => TIMELINE_KINDS.includes(k));
  res.json(timeline(p, { limit, ...(kinds.length && { kinds }) }));
});

// GET /api/audit.csv?patientId=&type=&from=&to=&limit= -> the audit log as a download
api.get('/audit.csv', (req, res) => {
  const { patientId, type, from, to } = req.query;
  for (const [k, v] of [['from', from], ['to', to]]) if (v && !Number.isFinite(Date.parse(v))) return res.status(400).json({ error: `${k} must be an ISO date` });
  const limit = Math.min(20_000, Math.max(1, Number.parseInt(req.query.limit, 10) || 5000));
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="heartbridge-audit.csv"').send(auditCsv({ patientId, type, from, to, limit }));
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
// Open YELLOW triage alerts carry the standing-order check (protocols.eligibility), so the
// worklist can show the one-click protocol card without another request.
api.get('/alerts', (_req, res) =>
  res.json(
    store.listAlerts().map((a) => {
      if ((a.kind ?? 'triage') !== 'triage' || a.tier !== 'YELLOW' || a.status === 'resolved') return a;
      const p = store.getPatient(a.patientId);
      const protocol = p && protocols.eligibility(p, a);
      return protocol?.triggered ? { ...a, protocolCheck: protocol } : a;
    }),
  ),
);

// POST /api/alerts/:id/protocol { by?, protocolId? } -> { alert, task, message, fhir }
// Re-checks eligibility server-side (409 with the failing checks if not eligible), then sends
// the clinic-authored instructions, moves the alert to contacted, schedules a re-weigh task.
api.post('/alerts/:id/protocol', async (req, res) => {
  try {
    res.json(await protocols.apply(req.params.id, { by: req.body?.by, protocolId: req.body?.protocolId }));
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, ...(err.checks && { checks: err.checks }) });
  }
});

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

// PATCH /api/alerts { ids, status?: 'acknowledged', assignee?, by? }
//   -> { results: [{ id, ok, alert?, unchanged?, error? }], updated, failed }
// Bulk actions for routine work (the dashboard's "Acknowledge selected" / "Assign selected to me").
// Deliberately narrower than the single-alert PATCH above:
//  - a RED alert is refused: an emergency is read and handled one at a time, on its own card;
//  - only `acknowledged` can be set (contacted and resolved say something about one patient);
//  - nothing moves backwards: an alert that is already acknowledged or contacted keeps its status.
// One bad id never fails the rest: every id gets its own result. Each change writes the same
// `nurse_action` audit row as the single PATCH (plus bulk: true), and a patient is told
// "<nurse> saw your update" once, however many of their alerts were in the batch.
const BULK_MAX = 50;
const isName = (v) => typeof v === 'string' && v.trim() !== '' && v.length <= 80;
api.patch('/alerts', async (req, res) => {
  const { ids, status, assignee, by } = req.body ?? {};
  const bad = (error) => res.status(400).json({ error });
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !id)) return bad('ids must be a non-empty array of alert ids');
  if (ids.length > BULK_MAX) return bad(`at most ${BULK_MAX} alerts per request`);
  if (status !== undefined && !STATUSES.includes(status)) return bad(`status must be one of ${STATUSES}`);
  if (status !== undefined && status !== 'acknowledged') return bad('only "acknowledged" can be set in bulk; contacted and resolved are done per alert');
  if (assignee !== undefined && !isName(assignee)) return bad('assignee must be a name of at most 80 characters');
  if (by !== undefined && !isName(by)) return bad('by must be a name of at most 80 characters');
  if (status === undefined && assignee === undefined) return bad('nothing to do: give status and/or assignee');

  const results = [];
  const acknowledged = [];
  for (const id of new Set(ids)) {
    const a = store.getAlert(id);
    const refuse = (error) => results.push({ id, ok: false, error });
    if (!a) refuse('not found');
    else if (a.tier === 'RED') refuse('RED alerts are handled one at a time');
    else if (a.status === 'resolved') refuse('already resolved');
    else {
      const patch = {};
      if (status && a.status === 'open') patch.status = status;
      if (assignee !== undefined && a.assignee !== assignee.trim()) patch.assignee = assignee.trim();
      if (!Object.keys(patch).length) {
        results.push({ id, ok: true, unchanged: true });
        continue;
      }
      if (by !== undefined) patch.by = by.trim();
      store.updateAlert(id, patch);
      store.audit('nurse_action', a.patientId, { alertId: id, ...patch, bulk: true });
      if (patch.status === 'acknowledged') acknowledged.push(a);
      results.push({ id, ok: true });
    }
  }
  await notifyAckMany(acknowledged, by ?? assignee);
  for (const r of results) if (r.ok) r.alert = store.getAlert(r.id);
  res.json({ results, updated: results.filter((r) => r.ok && !r.unchanged).length, failed: results.filter((r) => !r.ok).length });
});

// A nurse marked a triage alert a false alarm: the patient list shouldn't keep showing that
// tier. lastTier becomes the highest tier among their other open triage alerts, else GREEN.
function clearFalseAlarmTier(alert) {
  const p = store.getPatient(alert.patientId);
  if (!p || p.lastTier !== alert.tier) return;
  const open = store.listAlerts(p.id).filter((x) => x.id !== alert.id && (x.kind ?? 'triage') === 'triage' && x.status !== 'resolved');
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

// POST /api/patients/:id/unlink { role?: 'patient' | 'caregiver' } -> releases that channel link
// (default patient), so a new phone can JOIN with the care code. Nurse-only in effect: it sits
// behind API_TOKEN like the rest of /api.
api.post('/patients/:id/unlink', (req, res) => {
  const p = store.getPatient(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const role = req.body?.role === 'caregiver' ? 'caregiver' : 'patient';
  if (role === 'caregiver') store.updatePatient(p.id, { caregiver: { ...p.caregiver, chatId: null, phone: null } });
  else store.updatePatient(p.id, { chatId: null, phone: null });
  store.audit('channel_unlink', p.id, { role });
  res.json({ ok: true, role });
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

// POST /api/devices/readings { patientId, type: 'weight'|'spo2'|'hr', value, device?, ts?, readingId? }
//   -> 201 { ...reading, tier }  (200 with the original reading when readingId was already seen)
// The reading is judged by the same triage rules as a check-in answer (core/devicetriage.js).
api.post('/devices/readings', async (req, res) => {
  const { status, body } = await ingestReading(req.body ?? {});
  res.status(status).json(body);
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
