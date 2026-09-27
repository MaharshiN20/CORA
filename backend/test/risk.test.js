// Risk v2: baseline (unchanged) + dynamic factors from getSignals, trend, and history.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-risk-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';

let store, clock, risk, history;
before(async () => {
  store = await import('../src/store.js');
  clock = await import('../src/core/clock.js');
  risk = await import('../src/core/risk.js');
  history = await import('../src/insights/riskHistory.js');
});
beforeEach(() => {
  store.reset();
  clock.reset();
});

// Baseline 12 = age 78 (2) + 2 admissions (3) + EF 30 (2) + LOS 6 (1) + CKD (2) + diabetes (1) + lives alone (1)
const garcia = () => ({
  id: 'x1',
  age: 78,
  profile: { priorAdmits12mo: 2, ejectionFraction: 30, lengthOfStay: 6, ckd: true, diabetes: true, copd: false, livesAlone: true },
});
// Baseline 1 = age 65-74 only
const lowRisk = () => ({ id: 'x2', age: 66, profile: { priorAdmits12mo: 0, ejectionFraction: 50, lengthOfStay: 2 } });

// Every signal at a "no data / fine" value.
const QUIET = {
  daysSinceDischarge: 3, checkinsCompleted7d: 3, missedCheckins7d: 0, adherence7d: null, unconfirmedDoses7d: 0,
  weightDelta24h: null, weightDelta7d: null, openAlerts: 0, openRedAlerts: 0, sdohFlags: [], lessonScore: null,
  rpmDays30: 3, lastCheckinAt: null, lastTier: null,
};
const dyn = (patch, p = lowRisk()) => risk.scoreRisk(p, { ...QUIET, ...patch });
const labels = (r) => r.dynamic.factors.map((f) => `${f.label} +${f.points}`);

test('without signals: exactly the old baseline behaviour', () => {
  const r = risk.scoreRisk(garcia());
  assert.equal(r.score, 12);
  assert.equal(r.tier, 'High');
  assert.deepEqual(r.plan, { checkinsPerDay: 2, askSpo2: true, askOrthopnea: true });
  assert.equal(r.factors.length, 7);
  assert.equal(r.dynamic, undefined);
  assert.deepEqual(r.baseline, { score: 12, factors: r.factors });
  assert.equal(risk.scoreRisk(lowRisk()).tier, 'Low');
});

test('seed tiers unchanged', () => {
  assert.equal(store.getPatient('p1').riskTier, 'High');
  assert.equal(store.getPatient('p5').riskTier, 'Low');
});

test('quiet/null signals add 0 points', () => {
  const r = dyn({});
  assert.equal(r.dynamic.score, 0);
  assert.deepEqual(r.dynamic.factors, []);
  assert.equal(r.score, 1);
  // Explicit nulls everywhere, and a missing signals field entirely.
  const allNull = Object.fromEntries(Object.keys(QUIET).map((k) => [k, null]));
  assert.equal(risk.scoreRisk(lowRisk(), allNull).dynamic.score, 0);
  assert.equal(risk.scoreRisk(lowRisk(), {}).dynamic.score, 0);
});

test('missed check-ins: 1 -> +1, 2-3 -> +2, 4+ -> +3', () => {
  assert.deepEqual(labels(dyn({ missedCheckins7d: 1 })), ['Missed 1 check-in this week +1']);
  assert.deepEqual(labels(dyn({ missedCheckins7d: 2 })), ['Missed 2 check-ins this week +2']);
  assert.deepEqual(labels(dyn({ missedCheckins7d: 5 })), ['Missed 5 check-ins this week +3']);
});

test('adherence under 80%: +2, under 50%: +3; 80%+ or null: 0', () => {
  assert.deepEqual(labels(dyn({ adherence7d: 0.67 })), ['Medication adherence 67% this week (under 80%) +2']);
  assert.deepEqual(labels(dyn({ adherence7d: 0.4 })), ['Medication adherence 40% this week (under 80%) +3']);
  assert.equal(dyn({ adherence7d: 0.8 }).dynamic.score, 0);
  assert.equal(dyn({ adherence7d: null }).dynamic.score, 0);
});

test('weight trend: +3 lb/7d -> +2, +5 -> +3; +2 lb/24h -> +1', () => {
  assert.deepEqual(labels(dyn({ weightDelta7d: 3.2 })), ['Weight up 3.2 lb this week +2']);
  assert.deepEqual(labels(dyn({ weightDelta7d: 5 })), ['Weight up 5 lb this week +3']);
  assert.deepEqual(labels(dyn({ weightDelta24h: 2.4 })), ['Weight up 2.4 lb in 24 hours +1']);
  assert.equal(dyn({ weightDelta7d: 2.9, weightDelta24h: 1.9 }).dynamic.score, 0);
  assert.equal(dyn({ weightDelta7d: -4 }).dynamic.score, 0); // weight loss is triage's job, not risk points
});

test('open alerts: RED +3, others +1', () => {
  assert.deepEqual(labels(dyn({ openAlerts: 1, openRedAlerts: 1 })), ['1 open RED alert +3']);
  assert.deepEqual(labels(dyn({ openAlerts: 3, openRedAlerts: 1 })), ['1 open RED alert +3', '2 other open alerts +1']);
  assert.deepEqual(labels(dyn({ openAlerts: 1, openRedAlerts: 0 })), ['1 other open alert +1']);
});

test('SDOH flags: +1 each, capped at +2, human labels', () => {
  assert.deepEqual(labels(dyn({ sdohFlags: ['transportation'] })), ['Social needs: no transportation +1']);
  assert.deepEqual(labels(dyn({ sdohFlags: ['transportation', 'medication_cost', 'food_insecurity'] })), [
    "Social needs: no transportation, can't afford medications, food insecurity +2",
  ]);
});

test('low lesson score (< 50%) +1', () => {
  assert.deepEqual(labels(dyn({ lessonScore: 0.3 })), ['Low self-care understanding (lesson score 30%) +1']);
  assert.equal(dyn({ lessonScore: 0.5 }).dynamic.score, 0);
});

test('tier boundaries use baseline + dynamic (4 = Med, 7 = High) and plan follows tier', () => {
  // lowRisk baseline 1
  assert.equal(dyn({ missedCheckins7d: 2 }).tier, 'Low'); // 3
  const med = dyn({ missedCheckins7d: 2, openAlerts: 1 }); // 4
  assert.equal(med.score, 4);
  assert.equal(med.tier, 'Med');
  assert.deepEqual(med.plan, risk.PLANS.Med);
  const high = dyn({ missedCheckins7d: 5, adherence7d: 0.4 }); // 7
  assert.equal(high.score, 7);
  assert.equal(high.tier, 'High');
  assert.deepEqual(high.plan, risk.PLANS.High);
  // factors = baseline then dynamic
  assert.deepEqual(high.factors.map((f) => f.label), ['Age 65–74', 'Missed 5 check-ins this week', 'Medication adherence 40% this week (under 80%)']);
});

test('trend vs previous score: up / down / flat, default = patient.riskScore', () => {
  const s = { ...QUIET, missedCheckins7d: 2 }; // total 3
  assert.equal(risk.scoreRisk(lowRisk(), s, { previousScore: 1 }).dynamic.trend, 'up');
  assert.equal(risk.scoreRisk(lowRisk(), s, { previousScore: 5 }).dynamic.trend, 'down');
  assert.equal(risk.scoreRisk(lowRisk(), s, { previousScore: 3 }).dynamic.trend, 'flat');
  assert.equal(risk.scoreRisk(lowRisk(), s).dynamic.trend, 'flat'); // no previous score known
  assert.equal(risk.scoreRisk({ ...lowRisk(), riskScore: 1 }, s).dynamic.trend, 'up');
});

test('recordRisk appends history rows; trend compares with the last row', () => {
  const p = store.getPatient('p5'); // Smith: Low baseline
  const quiet = { ...QUIET };
  const r1 = history.recordRisk(p, quiet);
  assert.deepEqual(Object.keys(r1).sort(), ['patientId', 'score', 'tier', 'ts']);
  assert.equal(r1.patientId, 'p5');
  assert.ok(Math.abs(Date.parse(r1.ts) - clock.now()) < 1000); // demo-clock time

  clock.advance(clock.DAY);
  const worse = { ...QUIET, missedCheckins7d: 4, adherence7d: 0.4 };
  assert.equal(history.currentRisk(p, worse).dynamic.trend, 'up');
  const r2 = history.recordRisk(p, worse);
  assert.ok(r2.score > r1.score);

  clock.advance(clock.DAY);
  assert.equal(history.currentRisk(p, quiet).dynamic.trend, 'down');

  const rows = history.riskHistory('p5');
  assert.deepEqual(rows.map((r) => r.score), [r1.score, r2.score]);
  assert.deepEqual(history.lastRisk('p5'), r2);
  assert.equal(history.lastRisk('nobody'), null);
  assert.deepEqual(history.riskHistory('p1'), []); // per-patient
});

test('recordRisk with real getSignals (no signals passed) works on a seed patient', () => {
  const row = history.recordRisk(store.getPatient('p1'));
  assert.equal(row.patientId, 'p1');
  assert.ok(['Low', 'Med', 'High'].includes(row.tier));
  assert.ok(row.score >= 12); // never below Garcia's baseline
});

test('core/risk.js recordRisk (what aireview.js calls) appends to history', async () => {
  const p = store.getPatient('p2');
  const row = await risk.recordRisk(p);
  assert.equal(row.patientId, 'p2');
  assert.deepEqual(history.riskHistory('p2'), [row]);
  // Never throws into the caller: a broken patient resolves to null.
  assert.equal(await risk.recordRisk(null), null);
});
