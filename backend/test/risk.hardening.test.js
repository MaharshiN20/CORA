// Phase 3: risk overrides the additive score got wrong (silent patients, open RED), a cap on
// double counting, and hysteresis so a patient doesn't flap between tiers on a one-point wobble.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-risk-hard-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';

let store, clock, risk, signals;
before(async () => {
  store = await import('../src/store.js');
  clock = await import('../src/core/clock.js');
  risk = await import('../src/core/risk.js');
  signals = await import('../src/core/signals.js');
});
beforeEach(() => {
  store.reset();
  clock.reset();
});

// baseline 1 (age 66 only)
const lowRisk = (extra = {}) => ({ id: 'x2', age: 66, profile: { priorAdmits12mo: 0, ejectionFraction: 50, lengthOfStay: 2 }, ...extra });
const QUIET = {
  daysSinceDischarge: 10, checkinsCompleted7d: 5, missedCheckins7d: 0, adherence7d: null, unconfirmedDoses7d: 0,
  weightDelta24h: null, weightDelta7d: null, openAlerts: 0, openRedAlerts: 0, sdohFlags: [], lessonScore: null,
  rpmDays30: 5, lastCheckinAt: null, lastTier: null, silentDays: 0,
};
const score = (patch, p = lowRisk()) => risk.scoreRisk(p, { ...QUIET, ...patch });

// ---- silent patients ----
test('3+ days without a check-in adds a factor and floors the tier at Med', () => {
  const r = score({ silentDays: 4 });
  assert.ok(r.factors.some((f) => /No check-in for 4 days/.test(f.label)), JSON.stringify(r.factors));
  assert.equal(r.tier, 'Med');
  assert.equal(r.plan.askOrthopnea, true, 'asked more questions when they do answer');
});
test('2 silent days, or unknown, change nothing', () => {
  assert.equal(score({ silentDays: 2 }).tier, 'Low');
  assert.equal(score({ silentDays: null }).tier, 'Low');
  const old = { ...QUIET };
  delete old.silentDays;
  assert.equal(risk.scoreRisk(lowRisk(), old).tier, 'Low', 'signals from before this field existed still work');
});
test('getSignals reports silentDays: since the last check-in, or since discharge if there never was one', () => {
  const p = store.getPatient('p2');
  const last = Date.parse(p.checkins.at(-1).ts);
  const expected = Math.floor((clock.now() - last) / clock.DAY);
  assert.equal(signals.getSignals(p).silentDays, expected);
  const fresh = { ...p, checkins: [], dischargedAt: new Date(clock.now() - 5 * clock.DAY).toISOString() };
  assert.equal(signals.getSignals(fresh).silentDays, 5);
});
test('a patient discharged under 3 days ago is never "silent" yet', () => {
  const fresh = { ...store.getPatient('p2'), checkins: [], dischargedAt: new Date(clock.now() - 2 * clock.DAY).toISOString() };
  assert.equal(signals.getSignals(fresh).silentDays, null);
});

// ---- open RED ----
test('an open RED alert makes the patient High whatever the arithmetic says', () => {
  const r = score({ openAlerts: 1, openRedAlerts: 1 });
  assert.ok(r.score < 7, `additive score ${r.score} alone would not be High`);
  assert.equal(r.tier, 'High');
  assert.equal(r.plan.checkinsPerDay, 2);
});

// ---- cap ----
test('dynamic points are capped at 10, and the factors still add up to the score', () => {
  const r = score({
    missedCheckins7d: 5, adherence7d: 0.2, weightDelta7d: 6, weightDelta24h: 3, openAlerts: 3, openRedAlerts: 1,
    sdohFlags: ['transportation', 'medication_cost'], lessonScore: 0.1, silentDays: 5,
  });
  assert.equal(r.dynamic.score, 10);
  assert.equal(r.dynamic.factors.reduce((s, f) => s + f.points, 0), 10);
  assert.ok(r.dynamic.factors.some((f) => /capped/i.test(f.label)));
  assert.equal(r.score, r.baseline.score + 10);
});
test('under the cap nothing is added to the factor list', () => {
  const r = score({ missedCheckins7d: 2 });
  assert.ok(!r.dynamic.factors.some((f) => /capped/i.test(f.label)));
});

// ---- hysteresis ----
// baseline 1; dynamic from missed check-ins: 1 missed = +1, 2-3 = +2, 4+ = +3
test('a High patient stays High one point below the cutoff, and drops at two below', () => {
  const high = lowRisk({ riskTier: 'High' });
  assert.equal(score({ missedCheckins7d: 3, openAlerts: 0, sdohFlags: ['transportation', 'x'] }, high).score, 5, 'sanity: 1 + 2 + 2 = 5');
  // 1 + 3 (missed) + 2 (sdoh) = 6 -> would be Med, stays High
  assert.equal(score({ missedCheckins7d: 4, sdohFlags: ['transportation', 'medication_cost'] }, high).tier, 'High');
  // 1 + 2 + 2 = 5 -> two below the cutoff: drops to Med
  assert.equal(score({ missedCheckins7d: 3, sdohFlags: ['transportation', 'medication_cost'] }, high).tier, 'Med');
});
test('a Med patient stays Med one point below its cutoff, and drops at two below', () => {
  const med = lowRisk({ riskTier: 'Med' });
  assert.equal(score({ missedCheckins7d: 2 }, med).tier, 'Med', '1 + 2 = 3 -> stays Med');
  assert.equal(score({ missedCheckins7d: 1 }, med).tier, 'Low', '1 + 1 = 2 -> Low');
});
test('no hysteresis upwards, and none without a saved tier', () => {
  assert.equal(score({ missedCheckins7d: 2 }, lowRisk({ riskTier: 'Low' })).tier, 'Low', '3 stays Low');
  assert.equal(score({ missedCheckins7d: 2 }, lowRisk()).tier, 'Low');
  assert.equal(risk.scoreRisk(lowRisk({ riskTier: 'High' })).tier, 'Low', 'baseline-only reads are exact');
});
