// Phase 5: impact numbers that were quietly wrong or misleading.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-insights-hard-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, clock, metrics, journeys;
before(async () => {
  store = await import('../src/store.js');
  clock = await import('../src/core/clock.js');
  metrics = await import('../src/insights/metrics.js');
  journeys = await import('../src/insights/journeys.js');
});
beforeEach(() => store.reset());

const resp = (flags) => flags.map((f, i) => ({ day: i + 1, responded: f !== 0, recoveredVia: null }));
const J = (over) => ({ id: 'j', source: 'cohort', language: 'en', responses: resp([1, 1, 1, 1]), readmitted: false, rpmDays: 3, alerts: [], ...over });

// ---- live readmission is not "100% readmitted" ----
test('a live patient is "not readmitted" only after the full 30-day window; before that it is unknown', () => {
  const p = store.getPatient('p2');
  const young = journeys.liveJourney({ ...p, dischargedAt: new Date(clock.now() - 10 * clock.DAY).toISOString() }, { alerts: [], audit: [] });
  assert.equal(young.readmitted, null);
  const done = journeys.liveJourney({ ...p, dischargedAt: new Date(clock.now() - 31 * clock.DAY).toISOString() }, { alerts: [], audit: [] });
  assert.equal(done.readmitted, false);
  const alerts = [{ patientId: p.id, tier: 'RED', outcome: 'readmitted', status: 'resolved', history: [] }];
  const bad = journeys.liveJourney({ ...p, dischargedAt: new Date(clock.now() - 10 * clock.DAY).toISOString() }, { alerts, audit: [] });
  assert.equal(bad.readmitted, true, 'a recorded readmission counts at once');
});
test('freshly discharged live patients give no readmission rate (unknown), not a made-up 0% or 100%', () => {
  const m = metrics.impact(journeys.liveJourneys());
  assert.equal(m.readmission.overall.n, 0);
  assert.equal(m.readmission.overall.rate, null);
  assert.equal(m.sampleIsSmall, true);
});
test('a handful of known outcomes is flagged as a small sample', () => {
  const live = [J({ source: 'live', readmitted: true }), J({ id: 'k', source: 'live', readmitted: false })];
  const m = metrics.impact(live);
  assert.equal(m.readmission.overall.n, 2);
  assert.equal(m.sampleIsSmall, true);
  const many = Array.from({ length: 12 }, (_, i) => J({ id: `m${i}`, source: 'live', readmitted: i % 4 === 0 }));
  assert.equal(metrics.impact(many).sampleIsSmall, false);
});

// ---- SLA ----
test('an open alert still inside its SLA window is not counted as a miss; an overdue one is', () => {
  const js = [J({
    alerts: [
      { tier: 'RED', status: 'open', outcome: null, ackMinutes: null, ageMinutes: 5 }, // 5 of 15 min used: pending
      { tier: 'RED', status: 'open', outcome: null, ackMinutes: null, ageMinutes: 40 }, // overdue: miss
      { tier: 'RED', status: 'resolved', outcome: 'true_positive', ackMinutes: 10 }, // hit
    ],
  })];
  const m = metrics.impact(js);
  assert.equal(m.alerts.withinSlaByTier.RED, 0.5, '1 hit of 2 that are due (the pending one is excluded)');
  assert.equal(m.alerts.pendingWithinSla, 1);
});
test('the SLA table is the store\'s, not a copy', () => {
  assert.deepEqual(metrics.SLA_MINUTES, { RED: 15, YELLOW: 240, INFO: 1440 });
  assert.equal(metrics.SLA_MINUTES.RED * 60_000, store.SLA_MS.RED);
});

// ---- alert load ----
test('nurse load counts actionable alerts over the days actually observed, not INFO tasks over 30 days', () => {
  const alerts = [
    { tier: 'RED', status: 'resolved', outcome: 'true_positive', ackMinutes: 3 },
    { tier: 'YELLOW', status: 'resolved', outcome: 'true_positive', ackMinutes: 30 },
    { tier: 'INFO', status: 'resolved', outcome: 'other', ackMinutes: 300 },
    { tier: 'INFO', status: 'resolved', outcome: 'other', ackMinutes: 300 },
  ];
  const week = [J({ source: 'live', days: 5, readmitted: null, alerts })];
  const m = metrics.impact(week, { nurses: 1 });
  assert.equal(m.alerts.total, 4, 'everything is still counted in the total');
  assert.equal(m.alerts.actionable, 2);
  assert.equal(m.alerts.perNursePerDay, 0.4, '2 actionable / (1 nurse * 5 days)');
});
test('without a day count (hand-built or cohort journeys) the 30-day window is used, as before', () => {
  const m = metrics.impact([J({ alerts: [{ tier: 'RED', status: 'resolved', outcome: 'true_positive', ackMinutes: 3 }] })], { nurses: 2, windowDays: 30 });
  assert.equal(m.alerts.perNursePerDay, 0.017);
});

// ---- projected avoided is labelled by what it is based on ----
test('the avoided-readmissions figure says whether it is a synthetic assumption or observed data', () => {
  const engaged = J({ readmitted: false });
  const lapsed = J({ id: 'x', responses: resp([0, 0, 0, 0]), readmitted: true });
  assert.equal(metrics.impact([engaged, lapsed]).projectedBasis, 'synthetic', 'a cohort journey is involved');
  const live = [J({ source: 'live' }), J({ id: 'y', source: 'live', responses: resp([0, 0, 0, 0]), readmitted: true })];
  assert.equal(metrics.impact(live).projectedBasis, 'observed');
  assert.equal(metrics.impact([]).projectedBasis, null);
});

// ---- ROI inputs ----
test('ROI inputs are clamped to sensible ranges, and the response says which were', () => {
  const r = metrics.roi({ discharges: '-50', readmitRate: '3', reduction: '2', costPerReadmit: '-1', penaltyPct: '9', tcmContactRate: '1.5', rpmEligibleRate: '-2', medicareRevenue: '-5' });
  assert.equal(r.inputs.discharges, 0);
  assert.equal(r.inputs.readmitRate, 1);
  assert.equal(r.inputs.reduction, 1);
  assert.equal(r.inputs.costPerReadmit, 0);
  assert.equal(r.inputs.penaltyPct, 1);
  assert.equal(r.inputs.tcmContactRate, 1);
  assert.equal(r.inputs.rpmEligibleRate, 0);
  assert.equal(r.inputs.medicareRevenue, 0);
  assert.deepEqual([...r.clamped].sort(), ['costPerReadmit', 'discharges', 'medicareRevenue', 'penaltyPct', 'readmitRate', 'reduction', 'rpmEligibleRate', 'tcmContactRate']);
  for (const v of Object.values(r.dollars)) assert.ok(v >= 0, 'no negative dollars');
});
test('in-range ROI inputs are untouched and nothing is reported clamped', () => {
  const r = metrics.roi({ discharges: '400', reduction: '0.3' });
  assert.equal(r.inputs.discharges, 400);
  assert.equal(r.inputs.reduction, 0.3);
  assert.deepEqual(r.clamped, []);
});
test('ROI: empty strings and nulls still fall back to defaults (query-string style)', () => {
  const r = metrics.roi({ discharges: '', reduction: null });
  assert.equal(r.inputs.discharges, metrics.ROI_DEFAULTS.discharges);
  assert.equal(r.inputs.reduction, metrics.ROI_DEFAULTS.reduction);
});

// ---- many patients: no per-patient scans ----
test('liveJourneys groups alerts and audit once, so cost does not grow with patients x log size', () => {
  for (let i = 0; i < 300; i++) store.audit('noise', `p${(i % 5) + 1}`, { i });
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) journeys.liveJourneys();
  assert.ok(performance.now() - t0 < 1500, 'fast');
  const all = journeys.liveJourneys();
  assert.equal(all.length, store.listPatients().length);
  assert.deepEqual(all.map((j) => j.patientId), store.listPatients().map((p) => p.id));
});
