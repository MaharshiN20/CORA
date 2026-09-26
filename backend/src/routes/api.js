// REST API for the nurse dashboard + demo controls.
import { Router } from 'express';
import * as store from '../store.js';
import * as channels from '../channels/index.js';
import { handleInbound, startCheckin } from '../core/agent.js';

export const api = Router();

api.get('/health', (_req, res) =>
  res.json({ ok: true, telegram: !!process.env.TELEGRAM_BOT_TOKEN, claude: !!process.env.ANTHROPIC_API_KEY }),
);

api.get('/patients', (_req, res) => res.json(store.listPatients()));

api.get('/patients/:id', (req, res) => {
  const p = store.getPatient(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json({ ...p, messages: store.listMessages(p.id) });
});

api.get('/alerts', (_req, res) => res.json(store.listAlerts()));

api.patch('/alerts/:id', (req, res) => {
  const a = store.updateAlert(req.params.id, { status: req.body.status });
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json(a);
});

// ---- demo controls ----

// Kick off a check-in for a patient right now (normally done by the scheduler).
api.post('/patients/:id/checkin', async (req, res) => {
  const p = store.getPatient(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const replies = await startCheckin(p.id);
  for (const r of replies) await channels.sendToPatient(p, r);
  res.json({ sent: replies.length });
});

// Pretend to be the patient without Telegram — handy for backend dev + demo backup.
api.post('/patients/:id/simulate', async (req, res) => {
  const { text, buttonData } = req.body;
  if (!store.getPatient(req.params.id)) return res.status(404).json({ error: 'not found' });
  const replies = await handleInbound({ patientId: req.params.id, text, buttonData });
  res.json(replies);
});

api.post('/reset', (_req, res) => {
  store.reset();
  res.json({ ok: true });
});
