// The language-layer eval, run for real inside `npm test` (rules only: offline, milliseconds).
// Before this, the dataset was validated but its gate was only checked when someone ran `npm run eval`.
//
// These are REGRESSION FLOORS measured on 2026-10-08, not goals. The honest weak spot is stated in
// the test names: free-text red flags in Vietnamese / Hindi / Chinese are caught by rules in 1 of 6
// messages each. Those languages depend on the LLM parser (see evals/RESULTS.md for hybrid numbers),
// so a deployment without a model should send non-English patients the "call 911 if..." safety net
// in every message, and this floor exists so the rules cannot get WORSE unnoticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLM_PROVIDER = 'none';

const here = path.dirname(fileURLToPath(import.meta.url));
const score = await import('../../evals/score.js');
const parser = await import('../src/core/parser.js');
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
  assert.ok(s.falseAlarm.calm >= 100, 'enough calm messages to mean something');
});

test('regression floor: rules precision does not fall below 92%, and English/Spanish recall holds', () => {
  assert.ok(s.micro.precision >= 0.92, `precision ${s.micro.precision}`);
  assert.ok(s.byLang.en.micro.recall >= 0.83, `en recall ${s.byLang.en.micro.recall}`);
  assert.ok(s.byLang.es.micro.recall >= 0.82, `es recall ${s.byLang.es.micro.recall}`);
  assert.ok(s.byLang.en.micro.precision >= 0.97 && s.byLang.es.micro.precision >= 0.97);
});

test('known limitation, pinned so it can only improve: rules-only red-flag recall for vi / hi / zh', () => {
  for (const lang of ['vi', 'hi', 'zh']) {
    const rf = s.byLang[lang].redFlag;
    assert.ok(rf.caught >= 1, `${lang}: ${rf.caught}/${rf.expected}`);
    assert.equal(s.byLang[lang].falseAlarm.alarms, 0, `${lang} raises no false alarms`);
  }
  // If this starts failing because the number went UP, raise the floor above.
  const nonNative = ['vi', 'hi', 'zh'].reduce((n, l) => n + s.byLang[l].redFlag.caught, 0);
  assert.ok(nonNative >= 3, `non-native red flags caught by rules: ${nonNative}/18`);
});

test('the dataset itself is balanced enough to trust: 44+ emergencies, 100+ calm messages', () => {
  assert.ok(s.redFlag.expected >= 44);
  assert.ok(s.falseAlarm.calm >= 100);
});
