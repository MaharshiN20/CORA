// Insights / impact analytics API (Maharshi lane). Mounted at /api/insights.
// Every endpoint combines the synthetic cohort and the live demo patients; pick with
// ?source=cohort|live|all (default all). The cohort is created on first use.
import { Router } from 'express';
import { journeysFor } from '../insights/journeys.js';
import { ensureCohort, regenerateCohort, DEFAULT_SEED, DEFAULT_SIZE } from '../insights/cohort.js';
import * as metrics from '../insights/metrics.js';

export const insights = Router();

const SOURCES = ['cohort', 'live', 'all'];

function journeys(req, res) {
  const source = req.query.source ?? 'all';
  if (!SOURCES.includes(source)) {
    res.status(400).json({ error: `source must be one of ${SOURCES.join(', ')}` });
    return null;
  }
  ensureCohort();
  return { source, js: journeysFor(source) };
}

const num = (v, fallback) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : fallback);

insights.get('/', (_req, res) =>
  res.json({ ok: true, endpoints: ['/impact', '/engagement', '/equity', '/roi', 'POST /cohort/regenerate'], sources: SOURCES }),
);

insights.get('/impact', (req, res) => {
  const j = journeys(req, res);
  if (j) res.json({ source: j.source, ...metrics.impact(j.js, { nurses: num(req.query.nurses, 2) }) });
});

insights.get('/engagement', (req, res) => {
  const j = journeys(req, res);
  if (j) res.json({ source: j.source, ...metrics.engagement(j.js) });
});

insights.get('/equity', (req, res) => {
  const j = journeys(req, res);
  if (j) res.json({ source: j.source, ...metrics.equity(j.js) });
});

// Query params override ROI_DEFAULTS. TCM/RPM rates fall back to what the journeys measured.
insights.get('/roi', (req, res) => {
  const j = journeys(req, res);
  if (!j) return;
  const measured = metrics.measuredRates(j.js);
  const params = { ...Object.fromEntries(Object.entries(measured).filter(([, v]) => v != null)), ...req.query };
  res.json({ source: j.source, measured, ...metrics.roi(params) });
});

insights.post('/cohort/regenerate', (req, res) => {
  const seed = num(req.body?.seed ?? req.query.seed, DEFAULT_SEED);
  const size = Math.min(500, Math.max(1, Math.floor(num(req.body?.size ?? req.query.size, DEFAULT_SIZE))));
  const rows = regenerateCohort({ seed, size });
  res.json({ ok: true, seed, size: rows.length });
});
