// Insights / impact analytics API (Maharshi lane). Mounted at /api/insights.
// Planned endpoints (see docs/team/MAHARSHI.md): /impact, /engagement, /equity, /cohort, /roi
import { Router } from 'express';

export const insights = Router();

insights.get('/', (_req, res) => res.json({ ok: true, todo: 'Maharshi lane: M2 insights' }));
