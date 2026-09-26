// Demo console controls (Prannav lane). Mounted at /api/demo.
// The frontend Demo page (Maharshi) calls these; see docs/CONTRACTS.md.
import { Router } from 'express';
import * as clock from '../core/clock.js';
import * as store from '../store.js';

export const demo = Router();

// GET /api/demo/clock -> { now, offsetMs }
demo.get('/clock', (_req, res) => res.json({ now: clock.nowISO(), offsetMs: clock.offset() }));

// POST /api/demo/advance { hours } -> moves the demo clock; the scheduler (P1) runs due jobs on 'advance'.
demo.post('/advance', (req, res) => {
  const hours = Number(req.body?.hours ?? 24);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) return res.status(400).json({ error: 'hours must be 0-720' });
  clock.advance(hours * clock.HOUR);
  res.json({ now: clock.nowISO(), offsetMs: clock.offset() });
});

// POST /api/demo/reset -> reseed data + real time
demo.post('/reset', (_req, res) => {
  store.reset();
  res.json({ ok: true, now: clock.nowISO() });
});

// GET /api/demo/scenarios -> [{ name, title, description }]  (empty until P4-15 lands;
// the Demo console should render whatever this returns)
demo.get('/scenarios', (_req, res) => res.json([]));

// TODO(core P1-2): POST /api/demo/tick -> run due scheduler jobs now
// TODO(core P4-15): POST /api/demo/scenario/:name
