// Red-flag detection (decides "call 911"): every case the eval harness found, plus the
// negation edges that must stay emergencies. Deterministic rules only; no LLM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRedFlags, parseFreeText } from '../src/core/parser.js';

const RED = (a) => a.chestPain || a.breath === 'rest' || a.fainting || a.confusion;

// Emergencies the old regexes missed (evals/RESULTS.md, M4 gate).
const MUST_ESCALATE = [
  ['short of breath even sitting on the couch', 'breath'],
  ['Good morning! lovely weather. btw my chest has been really tight since lunch', 'chestPain'],
  ['cant breath', 'breath'],
  ['chest pian bad', 'chestPain'],
  ['me falta el aire incluso descansando', 'breath'],
  ['hola! todo bien con los nietos. oye me duele mucho el pecho desde anoche', 'chestPain'],
  ['tengo el pecho apretado', 'chestPain'],
  // regressions + negation edges that are still emergencies
  ["I can't breathe", 'breath'],
  ['no puedo respirar', 'breath'],
  ['chest pain', 'chestPain'],
  ['dolor de pecho', 'chestPain'],
  ['No, I have chest pain', 'chestPain'],
  ['no appetite and chest pain', 'chestPain'],
  ['he has chest pain and is sweating', 'chestPain'],
  ['I think I am having a heart attack', 'chestPain'],
  ['I fainted this morning', 'fainting'],
  ['me desmayé en la cocina', 'fainting'],
  ["she's confused and doesn't know where she is", 'confusion'],
  ['está confundida', 'confusion'],
  ['pressure in my chest when resting', 'chestPain'],
];
for (const [text, flag] of MUST_ESCALATE) {
  test(`escalates: "${text}"`, () => {
    const a = parseFreeText(text);
    assert.ok(RED(a), `${JSON.stringify(a)}`);
    if (flag === 'breath') assert.equal(a.breath, 'rest');
    else assert.equal(a[flag], true);
  });
}

// Calm messages the old regexes flagged as emergencies.
const MUST_NOT_ESCALATE = [
  'no chest pain, no dizziness',
  'sin dolor de pecho',
  'no fainting, no confusion, just tired',
  'lol that mortgage bill gave me a heart attack',
  'I almost had a heart attack when I saw the price',
  "I'm confused about my meds",
  'the instructions are confusing',
  'ya no me duele el pecho',
  "I don't have chest pain anymore",
  'chest x-ray was fine, no pain',
];
for (const text of MUST_NOT_ESCALATE) {
  test(`does not escalate: "${text}"`, () => {
    assert.ok(!RED(parseFreeText(text)), JSON.stringify(parseFreeText(text)));
  });
}

// Breathless only lying down / waking up at night = orthopnea (YELLOW), not RED.
for (const text of [
  "181lbs. also cant breathe when i lie down, sleeping on 3 pillows",
  'no puedo respirar bien acostada',
  'woke up gasping for air twice',
]) {
  test(`orthopnea, not RED: "${text}"`, () => {
    const a = parseFreeText(text);
    assert.notEqual(a.breath, 'rest');
    assert.equal(a.orthopnea, true);
  });
}

test('at-rest context wins over lying down (still RED)', () => {
  assert.equal(parseFreeText("can't breathe even sitting up in bed").breath, 'rest');
});

test('detectRedFlags returns null for ordinary messages', () => {
  assert.equal(detectRedFlags('good morning, 172 lb today and feeling fine'), null);
  assert.equal(detectRedFlags(''), null);
});

// ---------- unprompted emergencies in languages without hand-written patterns ----------
test('vi/hi/zh unprompted emergency: the LLM parses, the rule decides, nurse alerted', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-redflag-llm-${process.pid}.json`);
  process.env.LLM_PROVIDER = 'lmstudio';
  const realFetch = globalThis.fetch;
  // Evidence-quoted extraction (parser.validateExtraction): each value cites the message.
  let parsed = { fields: { confusion: { value: true, evidence: 'lú lẫn' } }, textEn: 'My mother seems confused' };
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }] }));
    if (u.endsWith('/v1/chat/completions')) {
      const body = JSON.parse(opts.body);
      const content = body.messages[0].content.includes('extract heart-failure check-in answers') ? JSON.stringify(parsed) : '';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    }
    return realFetch(url, opts);
  };
  try {
    const llm = await import('../src/core/llm/index.js');
    const store = await import('../src/store.js');
    const agent = await import('../src/core/agent.js');
    await llm.detect({ force: true });
    store.reset();
    const r = await agent.handleInbound({ patientId: 'p3', text: 'Mẹ tôi có vẻ lú lẫn, không biết mình đang ở đâu' }); // Thanh, vi
    assert.equal(r[0].urgent, true);
    const alert = store.listAlerts()[0];
    assert.equal(alert.tier, 'RED');
    assert.ok(store.listAudit('p3').some((e) => e.type === 'llm_parse' && e.data.flags.confusion));

    // LLM says nothing alarming -> no escalation (the rule decides, not the model's tone)
    store.reset();
    parsed = { fields: { swelling: { value: 'mild', evidence: 'hơi sưng' } }, textEn: 'ankles a bit puffy' };
    const calm = await agent.handleInbound({ patientId: 'p3', text: 'mắt cá chân hơi sưng' });
    assert.notEqual(calm[0]?.urgent, true);
    assert.equal(store.listAlerts().filter((a) => a.tier === 'RED').length, 0);
  } finally {
    globalThis.fetch = realFetch;
    process.env.LLM_PROVIDER = 'none';
  }
});
