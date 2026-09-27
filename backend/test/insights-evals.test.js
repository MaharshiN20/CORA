// M4 eval harness: dataset validity + scoring math. No network, no LLM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLM_PROVIDER = 'none';

const here = path.dirname(fileURLToPath(import.meta.url));
const evalsDir = path.join(here, '..', '..', 'evals');
const score = await import('../../evals/score.js');
const parser = await import('../src/core/parser.js');

const rows = score.parseJsonl(fs.readFileSync(path.join(evalsDir, 'messages.jsonl'), 'utf8'));

test('dataset: >= 150 valid, unique, labelled messages in all five languages', () => {
  assert.ok(rows.length >= 150, `only ${rows.length} rows`);
  assert.deepEqual(score.validateRows(rows), []);
  for (const l of score.LANGS) assert.ok(rows.filter((r) => r.lang === l).length >= 20, `${l} under 20`);
  // Hard cases the harness exists to measure.
  const notes = rows.map((r) => r.note ?? '').join(' ');
  for (const kind of ['negation', 'typo', 'hidden emergency', 'sarcasm']) assert.match(notes, new RegExp(kind));
  assert.ok(rows.some((r) => /kg|kilo|公斤|किलो|ký/.test(r.text)), 'unit conversions');
  // Every step appears.
  for (const s of score.STEPS) assert.ok(rows.some((r) => r.step === s), `step ${s}`);
});

test('validateRows catches bad rows', () => {
  const bad = [
    { id: 'a', lang: 'xx', step: 'weight', text: 'x', expected: {} },
    { id: 'a', lang: 'en', step: 'nope', text: '', expected: { weightLb: 'heavy', mood: true } },
  ];
  const p = score.validateRows(bad).join('\n');
  for (const s of ['unknown lang', 'duplicate', 'unknown step', 'empty text', 'bad value weightLb', 'unknown field mood']) assert.match(p, new RegExp(s));
});

test('normalize coerces LLM output and drops junk', () => {
  assert.deepEqual(score.normalize({ weightLb: '176.4', breath: 'REST ', chestPain: 'true', dizzy: 'no', spo2: null, swelling: 'huge', mood: 'ok' }), {
    weightLb: 176.4,
    breath: 'rest',
    chestPain: true,
    dizzy: false,
  });
  assert.deepEqual(score.normalize(null), {});
});

test('compareField: values, tolerance, presence flags and negations', () => {
  const c = score.compareField;
  assert.deepEqual(c('weightLb', { weightLb: 176.4 }, { weightLb: 176 }), { tp: 1, fp: 0, fn: 0 }); // within 1 lb
  assert.deepEqual(c('weightLb', { weightLb: 176.4 }, { weightLb: 80 }), { tp: 0, fp: 1, fn: 1 }); // kg read as lb
  assert.deepEqual(c('weightLb', {}, { weightLb: 80 }), { tp: 0, fp: 1, fn: 0 });
  assert.deepEqual(c('breath', { breath: 'rest' }, {}), { tp: 0, fp: 0, fn: 1 });
  assert.deepEqual(c('diureticTaken', { diureticTaken: false }, { diureticTaken: false }), { tp: 1, fp: 0, fn: 0 });
  // Presence flags: "no chest pain" (false) vs a parser that says true = false positive only.
  assert.deepEqual(c('chestPain', { chestPain: false }, { chestPain: true }), { tp: 0, fp: 1, fn: 0 });
  assert.deepEqual(c('chestPain', { chestPain: false }, {}), { tp: 0, fp: 0, fn: 0 });
  assert.deepEqual(c('chestPain', { chestPain: true }, { chestPain: false }), { tp: 0, fp: 0, fn: 1 });
});

test('isEmergency matches the check-in definition', () => {
  assert.equal(score.isEmergency({ spo2: 89 }), true);
  assert.equal(score.isEmergency({ spo2: 90 }), false);
  assert.equal(score.isEmergency({ breath: 'rest' }), true);
  assert.equal(score.isEmergency({ breath: 'exertion', dizzy: true, orthopnea: true }), false);
  assert.equal(score.isEmergency({ chestPain: false }), false);
});

test('rulesPredict applies step-specific parsing like the check-in', () => {
  assert.deepEqual(score.rulesPredict(parser, '176.4 lbs', 'weight'), { weightLb: 176.4 });
  assert.deepEqual(score.rulesPredict(parser, '176.4 lbs', 'free'), {}); // numbers only mean weight at the weight step
  assert.deepEqual(score.rulesPredict(parser, 'forgot', 'diuretic'), { diureticTaken: false });
  assert.deepEqual(score.rulesPredict(parser, 'yes', 'orthopnea'), { orthopnea: true });
  assert.deepEqual(score.rulesPredict(parser, 'oxygen 88%', 'spo2'), { spo2: 88 });
  assert.equal(score.rulesPredict(parser, 'chest pressure since this morning', 'redflags').chestPain, true);
});

test('hybridPredict: LLM only when rules found nothing, and never for unprompted messages', () => {
  assert.deepEqual(score.hybridPredict({ weightLb: 176 }, { weightLb: 180, dizzy: true }, 'weight'), { weightLb: 176 });
  assert.deepEqual(score.hybridPredict({}, { chestPain: 'true' }, 'redflags'), { chestPain: true });
  assert.deepEqual(score.hybridPredict({}, { chestPain: true }, 'free'), {});
});

test('scoreRun + gate on a tiny hand-built run', () => {
  const data = [
    { id: 'a', lang: 'en', step: 'redflags', text: 'x', expected: { chestPain: true } },
    { id: 'b', lang: 'en', step: 'redflags', text: 'x', expected: { chestPain: false } },
    { id: 'c', lang: 'es', step: 'weight', text: 'x', expected: { weightLb: 170 } },
    { id: 'd', lang: 'vi', step: 'breath', text: 'x', expected: { breath: 'rest' } },
  ];
  const preds = {
    a: { fields: { chestPain: true }, ms: 1 },
    b: { fields: { chestPain: true }, ms: 3 }, // false alarm
    c: { fields: { weightLb: 170.5 }, ms: 2 },
    d: { fields: {}, ms: 4, error: 'timeout' }, // missed emergency (not en/es)
  };
  const s = score.scoreRun(data, preds);
  assert.deepEqual([s.micro.tp, s.micro.fp, s.micro.fn], [2, 1, 1]);
  assert.equal(s.micro.precision, 0.667);
  assert.equal(s.micro.recall, 0.667);
  assert.deepEqual([s.redFlag.caught, s.redFlag.expected], [1, 2]);
  assert.deepEqual([s.falseAlarm.alarms, s.falseAlarm.calm], [1, 2]);
  assert.deepEqual(s.latency, { p50: 2, p95: 4 });
  assert.equal(s.errors, 1);
  assert.equal(s.byLang.vi.redFlag.recall, 0);
  assert.equal(score.gate(s).pass, true); // the only miss is Vietnamese; the gate covers en/es
  preds.a.fields = {};
  assert.deepEqual(score.gate(score.scoreRun(data, preds)).misses.map((r) => r.id), ['a']);
});

test('percentile and report rendering', () => {
  assert.equal(score.percentile([5, 1, 3], 50), 3);
  assert.equal(score.percentile([], 95), null);
  const data = rows.slice(0, 5);
  const preds = Object.fromEntries(data.map((r) => [r.id, { fields: score.rulesPredict(parser, r.text, r.step), ms: 0.1 }]));
  const md = score.renderMarkdown({ rows: data, results: { rules: score.scoreRun(data, preds) }, meta: { date: '2026-09-27' } });
  for (const h of ['# Language-layer eval results', '## Gate', '## Summary', '## By language', '## By field', '## Details: rules']) assert.ok(md.includes(h), h);
});
