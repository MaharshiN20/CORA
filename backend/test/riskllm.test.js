// Risk LLM: deterministic features + the hybrid tier contract. No network (LLM call is mocked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slope, consecutiveGains, change24h, change7d, missedDiureticStreak, unfilledPrescriptions, buildCase, detectSignals } from '../src/riskllm/features.js';
import { mergeTier, mergeConcerns, reviewPatient, buildPrompt } from '../src/riskllm/index.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-26T12:00:00Z');
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const log = (lbs) => lbs.map((lb, i) => ({ ts: iso(lbs.length - 1 - i), lb }));

// Slow creep: +0.6-0.9 lb/day, never >= 2 in a day, only 3.8 over 6 days -> rules stay GREEN.
const creeper = {
  age: 71,
  dischargedAt: iso(6),
  dryWeightLb: 205,
  profile: { priorAdmits12mo: 1, ejectionFraction: 35, lengthOfStay: 4, diabetes: true, copd: true, livesAlone: false },
  meds: [{ name: 'Furosemide', dose: '40 mg', diuretic: true }],
  weights: log([205, 205.6, 206.3, 207, 207.9, 208.8]),
  doses: [
    { ts: iso(2), diuretic: true, taken: true },
    { ts: iso(1), diuretic: true, taken: false },
    { ts: iso(0), diuretic: true, taken: false },
  ],
  prescriptions: [
    { med: 'Furosemide', expectedPickup: iso(5), pickedUpAt: null },
    { med: 'Carvedilol', expectedPickup: iso(5), pickedUpAt: iso(5) },
  ],
  caregiver: { relation: 'wife' },
  checkins: [{ ts: iso(1), tier: 'GREEN', answers: { weightLb: 207.9, breath: 'normal', swelling: 'mild', redflagsAsked: true } }],
};

test('weight features', () => {
  assert.equal(change24h(creeper.weights), 0.9);
  assert.equal(change7d(creeper.weights), 3.8);
  assert.ok(slope(creeper.weights) > 0.7 && slope(creeper.weights) < 0.8);
  assert.equal(consecutiveGains(creeper.weights), 5);
  assert.equal(slope(log([150, 151])), null); // too few points
  assert.equal(consecutiveGains(log([150, 151, 150.5])), 0);
});

test('adherence + refill features', () => {
  assert.equal(missedDiureticStreak(creeper.doses), 2);
  assert.deepEqual(unfilledPrescriptions(creeper.prescriptions, NOW), [{ med: 'Furosemide', daysOverdue: 5 }]);
});

test('buildCase is complete and drops internal answer fields', () => {
  const c = buildCase(creeper, { rules: { tier: 'GREEN', flags: [] }, now: NOW });
  assert.equal(c.patient.daysSinceDischarge, 6);
  assert.deepEqual(c.patient.comorbidities, ['diabetes', 'copd']);
  assert.equal(c.weight.aboveDryWeightLb, 3.8);
  assert.equal(c.adherence.diureticDosesTaken7d, 1);
  assert.equal(c.todaysRulesTriage.tier, 'GREEN');
  assert.equal(c.recentCheckins[0].answers.redflagsAsked, undefined);
  assert.doesNotThrow(() => buildCase({}, { now: NOW })); // sparse patient
});

test('mergeTier: AI can raise to YELLOW, never lower, never RED', () => {
  assert.equal(mergeTier('GREEN', 'YELLOW'), 'YELLOW');
  assert.equal(mergeTier('GREEN', 'RED'), 'YELLOW');
  assert.equal(mergeTier('YELLOW', 'GREEN'), 'YELLOW');
  assert.equal(mergeTier('RED', 'GREEN'), 'RED');
  assert.equal(mergeTier('GREEN', 'GREEN'), 'GREEN');
});

const aiSays = (out) => async () => ({ model: 'mock', ...out });
const yellow = {
  tier: 'YELLOW',
  urgent: false,
  readmissionRisk: 'high',
  concerns: [{ category: 'fluid_trend', text: 'Steady weight gain', evidence: '+3.8 lb over 6 days' }],
  nurseSummary: 'Weight creeping up and diuretic not picked up.',
  suggestedActions: ['Call today'],
};

test('reviewPatient escalates GREEN -> YELLOW when AI sees a problem', async () => {
  const r = await reviewPatient(creeper, { rules: { tier: 'GREEN', flags: [] }, now: NOW }, { call: aiSays(yellow) });
  assert.equal(r.finalTier, 'YELLOW');
  assert.equal(r.escalate, true);
  // AI covered fluid_trend; code-detected refill + missed-diuretic signals get merged in.
  assert.deepEqual(r.concerns.map((c) => c.category), ['fluid_trend', 'refill', 'medication']);
});

test('reviewPatient never downgrades a RED from rules', async () => {
  const r = await reviewPatient(creeper, { rules: { tier: 'RED', flags: [{ text: 'Chest pain' }] }, now: NOW }, { call: aiSays({ ...yellow, tier: 'GREEN' }) });
  assert.equal(r.finalTier, 'RED');
  assert.equal(r.escalate, false);
});

test('reviewPatient returns null on failure so rules stand', async () => {
  const boom = async () => { throw new Error('network'); };
  assert.equal(await reviewPatient(creeper, { now: NOW }, { call: boom }), null);
  assert.equal(await reviewPatient(creeper, { now: NOW }, { call: async () => null }), null);
  assert.equal(await reviewPatient(creeper, { now: NOW }, { call: aiSays({ tier: 'MAYBE' }) }), null);
});

test('prompt carries case + patient messages', async () => {
  let seen;
  await reviewPatient(creeper, { now: NOW, messages: [{ ts: iso(1), text: 'had canned soup again' }] }, { call: async (p) => ((seen = p), null) });
  assert.match(seen, /<case>/);
  assert.match(seen, /canned soup/);
  assert.match(buildPrompt({}, []), /\(none\)/);
});

test('detectSignals: trend, refill, adherence, and everyday phrasing', () => {
  const c = buildCase(creeper, { now: NOW });
  const msgs = [
    { ts: iso(2), text: 'had chicken noodle soup and crackers' },
    { ts: iso(1), text: 'been sleeping in the recliner' },
    { ts: iso(0), text: 'shoes a bit tight. Linda is visiting her sister' },
  ];
  const s = detectSignals(c, msgs);
  const cats = s.map((x) => `${x.category}:${x.text}`);
  assert.ok(cats.includes('fluid_trend:Steady weight gain below the single-day alert threshold'));
  assert.ok(cats.includes('refill:Furosemide prescription not picked up'));
  assert.ok(cats.includes('medication:Diuretic missed'));
  assert.ok(cats.some((c) => c.startsWith('diet_sodium:')));
  assert.ok(cats.some((c) => c.startsWith('congestion:Possible orthopnea')));
  assert.ok(cats.some((c) => c.startsWith('congestion:Possible worsening edema')));
  assert.ok(cats.includes('social:Less support at home'));
  assert.match(s.find((x) => x.category === 'diet_sodium').evidence, /soup/);
});

test('detectSignals: stable patient with benign messages -> nothing', () => {
  const stable = { ...creeper, weights: log([140, 139.6, 140.2, 139.8, 140]), doses: [], prescriptions: [] };
  assert.deepEqual(detectSignals(buildCase(stable, { now: NOW }), [{ ts: iso(0), text: 'feeling good, walked the dog' }]), []);
});

test('mergeConcerns keeps AI wording and only adds uncovered categories', () => {
  const ai = [{ category: 'congestion', text: 'AI', evidence: 'x' }];
  const sig = [
    { category: 'congestion', text: 'code', evidence: 'y' },
    { category: 'refill', text: 'code', evidence: 'z' },
  ];
  assert.deepEqual(mergeConcerns(ai, sig).map((c) => `${c.category}:${c.text}`), ['congestion:AI', 'refill:code']);
  assert.equal(mergeConcerns(undefined, sig).length, 2);
});

test('mergeConcerns: distinct congestion signs survive when the LLM only mentions one', () => {
  const ai = [{ category: 'congestion', text: 'Orthopnea', evidence: '"cant lay flat so im propped up on the couch" (2026-09-25)' }];
  const sig = [
    { category: 'congestion', text: 'Possible orthopnea', evidence: '"cant lay flat so im propped up on the couch" (2026-09-25)', phrase: 'cant lay flat' },
    { category: 'congestion', text: 'Possible worsening edema', evidence: '"my sneakers dont fit" (2026-09-26)', phrase: 'sneakers dont fit' },
  ];
  assert.deepEqual(mergeConcerns(ai, sig).map((c) => c.text), ['Orthopnea', 'Possible worsening edema']);
});

test('mergeConcerns: no duplicate when the LLM already mentioned the keyword', () => {
  const ai = [{ category: 'congestion', text: 'Orthopnea and edema', evidence: "propped up on the couch; sneakers don't fit (2026-09-26)" }];
  const sig = [{ category: 'congestion', text: 'Possible worsening edema', evidence: '"fine. no swelling i think but my sneakers dont fit" (2026-09-26)', phrase: 'sneakers dont fit' }];
  const out = mergeConcerns(ai, sig);
  assert.equal(out.length, 1);
  assert.equal(out[0].phrase, undefined);
});
