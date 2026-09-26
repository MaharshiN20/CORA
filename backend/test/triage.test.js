import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triage, weightChange24h, weightChange7d, consecutiveMissedDiureticDays } from '../src/core/triage.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-26T09:00:00Z');
// daily weights, oldest -> newest, last one is "today"
const log = (...lbs) => lbs.map((lb, i) => ({ ts: new Date(NOW - (lbs.length - 1 - i) * DAY).toISOString(), lb }));
const codes = (r) => r.flags.map((f) => f.code).sort();

test('stable patient is GREEN with encouragement', () => {
  const r = triage({ weights: log(170, 170.4, 170.2), answers: { breath: 'normal', swelling: 'none' } });
  assert.equal(r.tier, 'GREEN');
  assert.deepEqual(r.flags, []);
  assert.deepEqual(r.advice, ['doing_great']);
});

test('weight trend helpers', () => {
  assert.equal(weightChange24h(log(170, 172.5)), 2.5);
  assert.equal(weightChange7d(log(170, 171, 172, 172.5, 173, 174, 175.2)), 5.2);
  assert.equal(weightChange24h(log(170)), null);
  // reading 3 days ago is too old for a 24h comparison
  assert.equal(weightChange24h([{ ts: new Date(NOW - 3 * DAY).toISOString(), lb: 170 }, { ts: new Date(NOW).toISOString(), lb: 175 }]), null);
});

test('+2 lb in 24h -> YELLOW', () => {
  const r = triage({ weights: log(170, 172) });
  assert.equal(r.tier, 'YELLOW');
  assert.deepEqual(codes(r), ['weight_24h']);
});

test('+1.9 lb in 24h -> GREEN with sodium advice', () => {
  const r = triage({ weights: log(170, 171.9) });
  assert.equal(r.tier, 'GREEN');
  assert.ok(r.advice.includes('low_sodium'));
});

test('slow creep of +5 lb over a week -> YELLOW', () => {
  const r = triage({ weights: log(170, 170.8, 171.6, 172.4, 173.2, 174, 175) });
  assert.equal(r.tier, 'YELLOW');
  assert.deepEqual(codes(r), ['weight_7d']);
});

test('seeded hero patient (Garcia) trips the 24h rule', () => {
  const r = triage({ weights: log(172, 172.4, 173, 173.2, 174.1, 176.8) });
  assert.equal(r.tier, 'YELLOW');
  assert.ok(codes(r).includes('weight_24h'));
});

for (const [answers, code] of [
  [{ chestPain: true }, 'chest_pain'],
  [{ breath: 'rest' }, 'sob_rest'],
  [{ confusion: true }, 'confusion'],
  [{ fainting: true }, 'syncope'],
  [{ spo2: 88 }, 'spo2_low'],
]) {
  test(`RED: ${code}`, () => {
    const r = triage({ weights: log(170, 170), answers });
    assert.equal(r.tier, 'RED');
    assert.ok(codes(r).includes(code));
  });
}

test('SpO2 bands: 90-92 YELLOW, 93+ fine', () => {
  assert.equal(triage({ answers: { spo2: 90 } }).tier, 'YELLOW');
  assert.equal(triage({ answers: { spo2: 92 } }).tier, 'YELLOW');
  assert.equal(triage({ answers: { spo2: 93 } }).tier, 'GREEN');
  assert.equal(triage({ answers: { spo2: 89 } }).tier, 'RED');
});

test('orthopnea and worsening swelling -> YELLOW; mild swelling -> advice only', () => {
  assert.equal(triage({ answers: { orthopnea: true } }).tier, 'YELLOW');
  assert.equal(triage({ answers: { swelling: 'worse' } }).tier, 'YELLOW');
  const mild = triage({ answers: { swelling: 'mild' } });
  assert.equal(mild.tier, 'GREEN');
  assert.ok(mild.advice.includes('elevate_legs'));
});

test('missed diuretic: 1 day advice, 2+ days YELLOW', () => {
  assert.equal(triage({ missedDiureticDays: 1 }).tier, 'GREEN');
  assert.ok(triage({ missedDiureticDays: 1 }).advice.includes('missed_dose'));
  assert.equal(triage({ missedDiureticDays: 2 }).tier, 'YELLOW');
});

test('breathless on exertion: advice alone, YELLOW with fluid signs', () => {
  assert.equal(triage({ weights: log(170, 170), answers: { breath: 'exertion' } }).tier, 'GREEN');
  const r = triage({ weights: log(170, 170), answers: { breath: 'exertion', swelling: 'worse' } });
  assert.equal(r.tier, 'YELLOW');
  assert.ok(codes(r).includes('sob_exertion_fluid'));
});

test('dizzy + rapid weight loss flags possible over-diuresis', () => {
  assert.equal(triage({ weights: log(170, 170), answers: { dizzy: true } }).tier, 'GREEN');
  const r = triage({ weights: log(170, 166.5), answers: { dizzy: true } });
  assert.equal(r.tier, 'YELLOW');
  assert.ok(codes(r).includes('dizzy_dehydration'));
});

test('RED outranks YELLOW, and multiple flags raise priority', () => {
  const red = triage({ answers: { chestPain: true } });
  const yellow3 = triage({ weights: log(170, 173), answers: { orthopnea: true, swelling: 'worse' } });
  const yellow1 = triage({ answers: { orthopnea: true } });
  assert.ok(red.priority > yellow3.priority);
  assert.ok(yellow3.priority > yellow1.priority);
});

test('consecutiveMissedDiureticDays counts back from the latest day', () => {
  const doses = [
    { ts: '2026-09-23T08:00:00Z', diuretic: true, taken: true },
    { ts: '2026-09-24T08:00:00Z', diuretic: true, taken: false },
    { ts: '2026-09-25T08:00:00Z', diuretic: true, taken: false },
    { ts: '2026-09-25T20:00:00Z', diuretic: false, taken: true },
  ];
  assert.equal(consecutiveMissedDiureticDays(doses), 2);
  assert.equal(consecutiveMissedDiureticDays([]), 0);
});
