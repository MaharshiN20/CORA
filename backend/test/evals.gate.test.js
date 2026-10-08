// The language-layer eval, run for real inside `npm test` (rules only: offline, milliseconds).
// Before this, the dataset was validated but its gate was only checked when someone ran `npm run eval`.
//
// These are REGRESSION FLOORS measured on 2026-10-08, not goals.
//  - English / Spanish: a hard gate. Every emergency row is caught, no false alarm.
//  - Vietnamese / Hindi / Chinese: hand-written red-flag lists since K15 (core/redflags-intl.js).
//    Before them the rules caught 1 emergency in 6 in each language; now they catch every row in
//    the file. Read that number for what it is: the rows and the patterns were written by the same
//    non-native author, and no native speaker has reviewed either. A separate set of 24 emergency
//    phrases written after the patterns were frozen scored 23 caught, 0 false alarms in 18 calm
//    ones (those rows are in the file now). So these floors stop the rules getting WORSE unnoticed;
//    they do not show real-world recall, which is why patients in these languages also get the
//    "call 911 if…" line under every question when no model is available (core/checkin.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLM_PROVIDER = 'none';

const here = path.dirname(fileURLToPath(import.meta.url));
const score = await import('../../evals/score.js');
const parser = await import('../src/core/parser.js');
const intl = await import('../src/core/redflags-intl.js');
const rows = score.parseJsonl(fs.readFileSync(path.join(here, '..', '..', 'evals', 'messages.jsonl'), 'utf8'));
const preds = Object.fromEntries(rows.map((r) => [r.id, { fields: score.rulesPredict(parser, r.text, r.step), ms: 0.1 }]));
const s = score.scoreRun(rows, preds);

test('GATE: every English and Spanish emergency is caught by the rules alone (100% red-flag recall)', () => {
  const g = score.gate(s);
  assert.deepEqual(g.misses.map((m) => `${m.id}: ${m.text}`), []);
  assert.equal(s.byLang.en.redFlag.recall, 1);
  assert.equal(s.byLang.es.redFlag.recall, 1);
});

test('rules raise no false alarm on any of the calm messages, in any language', () => {
  assert.deepEqual(s.falseAlarm.rows.map((r) => r.id ?? r), []);
  assert.equal(s.falseAlarm.alarms, 0);
  assert.ok(s.falseAlarm.calm >= 150, 'enough calm messages to mean something');
});

test('regression floor: rules precision does not fall below 92%, and English/Spanish recall holds', () => {
  assert.ok(s.micro.precision >= 0.92, `precision ${s.micro.precision}`);
  assert.ok(s.byLang.en.micro.recall >= 0.83, `en recall ${s.byLang.en.micro.recall}`);
  assert.ok(s.byLang.es.micro.recall >= 0.82, `es recall ${s.byLang.es.micro.recall}`);
  assert.ok(s.byLang.en.micro.precision >= 0.97 && s.byLang.es.micro.precision >= 0.97);
});

test('vi / hi / zh: rules-only red-flag recall is at least 90% (was 1 in 6), with zero false alarms', () => {
  for (const lang of ['vi', 'hi', 'zh']) {
    const { redFlag, falseAlarm } = s.byLang[lang];
    assert.ok(redFlag.expected >= 20, `${lang}: only ${redFlag.expected} emergency rows`);
    assert.ok(falseAlarm.calm >= 20, `${lang}: only ${falseAlarm.calm} calm rows`);
    // Measured: 23/23, 22/22, 22/22. The floor leaves room to add an honest failing row.
    assert.ok(redFlag.recall >= 0.9, `${lang}: ${redFlag.caught}/${redFlag.expected}, missed ${redFlag.misses.map((m) => m.id)}`);
    assert.equal(falseAlarm.alarms, 0, `${lang} false alarms: ${falseAlarm.rows.map((r) => r.id)}`);
  }
});

test('vi / hi / zh: the hard calm rows stay calm (negation, look-alike words, figures of speech)', () => {
  const emergency = (id) => score.isEmergency(preds[id].fields);
  const calm = ['vi-012', 'vi-030', 'vi-031', 'vi-032', 'vi-033', 'vi-034', 'vi-038', 'hi-012', 'hi-029', 'hi-030', 'hi-031', 'hi-032', 'hi-034', 'hi-036', 'zh-012', 'zh-029', 'zh-030', 'zh-031', 'zh-032', 'zh-034', 'zh-036'];
  for (const id of calm) assert.equal(emergency(id), false, `${id}: ${rows.find((r) => r.id === id).text}`);
  // ...and their mirror images are caught: "नहीं जा रहा" (not going away), "cha" (father, not "chả").
  for (const id of ['hi-027', 'vi-029', 'zh-028', 'vi-025', 'hi-025', 'zh-026']) assert.equal(emergency(id), true, `${id}: ${rows.find((r) => r.id === id).text}`);
});

test('breathless on exertion or lying down is not turned into a 911 in vi / hi / zh', () => {
  for (const id of ['vi-004', 'vi-035', 'vi-049', 'hi-004', 'hi-033', 'hi-047', 'zh-004', 'zh-033', 'zh-047']) assert.notEqual(preds[id].fields.breath, 'rest', id);
  for (const id of ['vi-037', 'hi-035', 'zh-035']) {
    assert.equal(preds[id].fields.orthopnea, true, `${id}: breathless lying down is orthopnea`);
    assert.notEqual(preds[id].fields.breath, 'rest', id);
  }
});

test('each hand-written list states who has reviewed it (nobody yet: that must stay visible)', () => {
  assert.deepEqual(Object.keys(intl.REVIEW).sort(), ['hi', 'vi', 'zh']);
  for (const [lang, r] of Object.entries(intl.REVIEW)) {
    assert.ok('reviewedBy' in r, `${lang}: reviewedBy`);
    assert.ok(typeof r.note === 'string' && r.note.length > 40, `${lang}: note`);
  }
});

test('the dataset itself is balanced enough to trust: 90+ emergencies, 150+ calm messages', () => {
  assert.ok(s.redFlag.expected >= 90);
  assert.ok(s.falseAlarm.calm >= 150);
});
