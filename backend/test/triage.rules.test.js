// Phase 3: triage rule additions. CLINICAL THRESHOLDS: these values are the author's reading of
// standard HF self-management guidance and need clinician sign-off (see the commit message).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triage, spo2Thresholds } from '../src/core/triage.js';

const H = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-26T09:00:00Z');
// readings as [hoursAgo, lb], oldest first; the last is "today"
const at = (...pairs) => pairs.map(([h, lb]) => ({ ts: new Date(NOW - h * H).toISOString(), lb }));
const codes = (r) => r.flags.map((f) => f.code).sort();

// ---- a skipped day no longer hides a gain ----
test('+3 lb over a skipped day (readings 2 days apart) is YELLOW', () => {
  const r = triage({ weights: at([60, 170], [0, 173]) });
  assert.equal(r.tier, 'YELLOW');
  assert.deepEqual(codes(r), ['weight_72h']);
});
test('+2 lb over 2.5 days is not enough on its own (needs 3)', () => {
  assert.equal(triage({ weights: at([60, 170], [0, 172]) }).tier, 'GREEN');
});
test('a reading older than 72 h is not compared', () => {
  assert.equal(triage({ weights: at([80, 170], [0, 173]) }).tier, 'GREEN', 'too old for the skipped-day rule');
});
test('the normal 24 h rule still wins when there is a reading from yesterday', () => {
  assert.deepEqual(codes(triage({ weights: at([24, 170], [0, 172.5]) })), ['weight_24h']);
});

// ---- dry weight ----
test('5+ lb above dry weight is YELLOW even when the day-to-day change is small', () => {
  const r = triage({ weights: at([48, 174.5], [24, 174.8], [0, 175]), dryWeightLb: 169 });
  assert.equal(r.tier, 'YELLOW');
  assert.deepEqual(codes(r), ['above_dry_weight']);
  assert.match(r.flags[0].text, /6 lb above dry weight \(169 lb\)/);
});
test('under 5 lb above dry weight, no dry weight on file, or already flagged for a gain: no extra flag', () => {
  assert.equal(triage({ weights: at([24, 170], [0, 171]), dryWeightLb: 167 }).tier, 'GREEN');
  assert.equal(triage({ weights: at([24, 174], [0, 175]) }).tier, 'GREEN');
  assert.deepEqual(codes(triage({ weights: at([24, 170], [0, 174]), dryWeightLb: 165 })), ['weight_24h'], 'one reason, not two');
});

// ---- big loss ----
test('a 5 lb drop in a day is YELLOW on its own (over-diuresis / bad scale reading)', () => {
  const r = triage({ weights: at([24, 175], [0, 169.5]) });
  assert.deepEqual(codes(r), ['weight_drop']);
  assert.equal(r.tier, 'YELLOW');
});
test('a 3 lb drop alone is still fine; with dizziness it is the existing dehydration flag', () => {
  assert.equal(triage({ weights: at([24, 175], [0, 171.5]) }).tier, 'GREEN');
  assert.deepEqual(codes(triage({ weights: at([24, 175], [0, 171.5]), answers: { dizzy: true } })), ['dizzy_dehydration']);
  assert.deepEqual(codes(triage({ weights: at([24, 175], [0, 169]), answers: { dizzy: true } })), ['dizzy_dehydration'], 'not flagged twice');
});

// ---- COPD-aware oxygen ----
test('spo2Thresholds: 90/93 normally, 88/90 with COPD', () => {
  assert.deepEqual(spo2Thresholds(false), { red: 90, yellow: 93 });
  assert.deepEqual(spo2Thresholds(true), { red: 88, yellow: 90 });
});
test('SpO2 89% is RED for most patients and YELLOW for a COPD patient', () => {
  assert.equal(triage({ weights: [], answers: { spo2: 89 } }).tier, 'RED');
  const copd = triage({ weights: [], answers: { spo2: 89 }, copd: true });
  assert.equal(copd.tier, 'YELLOW');
  assert.match(copd.flags[0].text, /COPD/);
});
test('SpO2 87% is RED for everyone; 91% is YELLOW normally and GREEN with COPD', () => {
  assert.equal(triage({ weights: [], answers: { spo2: 87 }, copd: true }).tier, 'RED');
  assert.equal(triage({ weights: [], answers: { spo2: 91 } }).tier, 'YELLOW');
  assert.equal(triage({ weights: [], answers: { spo2: 91 }, copd: true }).tier, 'GREEN');
});

// ---- blood pressure ----
test('systolic under 90 is YELLOW, under 80 is RED, 100-140 is fine', () => {
  assert.equal(triage({ weights: [], bp: { sbp: 118, dbp: 72 } }).tier, 'GREEN');
  const low = triage({ weights: [], bp: { sbp: 86, dbp: 52 } });
  assert.deepEqual(codes(low), ['bp_low']);
  assert.equal(low.tier, 'YELLOW');
  const crit = triage({ weights: [], bp: { sbp: 76, dbp: 40 } });
  assert.equal(crit.tier, 'RED');
  assert.deepEqual(codes(crit), ['bp_critical']);
});
test('very high blood pressure (180+/110+) is YELLOW', () => {
  assert.deepEqual(codes(triage({ weights: [], bp: { sbp: 186, dbp: 100 } })), ['bp_high']);
  assert.deepEqual(codes(triage({ weights: [], bp: { sbp: 150, dbp: 112 } })), ['bp_high']);
  assert.equal(triage({ weights: [], bp: { sbp: 150, dbp: 95 } }).tier, 'GREEN');
});
test('a bad bp object (missing or NaN) is ignored, never a crash or a false alarm', () => {
  for (const bp of [null, undefined, {}, { sbp: NaN, dbp: 80 }, { sbp: 'x' }]) assert.equal(triage({ weights: [], bp }).tier, 'GREEN');
});
