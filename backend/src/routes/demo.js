// Demo console controls (Prannav lane). Mounted at /api/demo.
// The frontend Demo page (Maharshi) calls these; see docs/CONTRACTS.md.
import { Router } from 'express';
import * as clock from '../core/clock.js';
import * as store from '../store.js';
import * as scheduler from '../core/scheduler.js';
import * as jobs from '../core/jobs.js';
import * as scenarios from '../core/scenarios.js';

export const demo = Router();

// GET /api/demo/clock -> { now, offsetMs }
demo.get('/clock', (_req, res) => res.json({ now: clock.nowISO(), offsetMs: clock.offset() }));

// POST /api/demo/advance { hours } -> moves the demo clock, plans the skipped window and
// runs every job that became due. -> { now, offsetMs, jobs: { ran, missed, failed } }
demo.post('/advance', async (req, res) => {
  const hours = Number(req.body?.hours ?? 24);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) return res.status(400).json({ error: 'hours must be 0-720' });
  const byMs = hours * clock.HOUR;
  clock.advance(byMs);
  const summary = await jobs.afterAdvance(byMs);
  res.json({ now: clock.nowISO(), offsetMs: clock.offset(), jobs: summary });
});

// POST /api/demo/tick -> run due jobs now -> { ran, missed, failed }
demo.post('/tick', async (_req, res) => res.json(await scheduler.tick()));

// GET /api/demo/jobs?patientId=&status=&kind= -> jobs sorted by dueAt
demo.get('/jobs', (req, res) => {
  const filter = Object.fromEntries(['patientId', 'status', 'kind'].filter((k) => req.query[k]).map((k) => [k, req.query[k]]));
  res.json(scheduler.listJobs(filter));
});

// POST /api/demo/reset -> reseed data + real time
demo.post('/reset', (_req, res) => {
  store.reset();
  jobs.replan();
  res.json({ ok: true, now: clock.nowISO() });
});

// GET /api/demo/scenarios -> [{ name, title, description, tier, patientId, steps }]
demo.get('/scenarios', (_req, res) => res.json(scenarios.list()));

// POST /api/demo/scenario/:name -> { name, patientId, steps, delayMs }
// Plays in the background at a human pace (the dashboard updates live over socket.io).
// ?fast=1 plays instantly and answers when done (tests, e2e).
demo.post('/scenario/:name', async (req, res) => {
  const fast = req.query.fast === '1' || req.body?.fast === true;
  try {
    res.json(await scenarios.run(req.params.name, fast ? { delayMs: 0, wait: true } : {}));
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});
