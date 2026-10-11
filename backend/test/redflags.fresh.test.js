// S4 (audit 2026-10-11): fresh phrasings, typos, look-alike characters and collapse vocabulary
// must still reach a 911, in every language the rules read; and the model is a second opinion
// that can add an emergency (never remove one) for every language, not just the model-only ones.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-fresh-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

const parser = await import('../src/core/parser.js');
const red = (t) => {
  const a = parser.parseFreeText(t);
  return !!(a.chestPain || a.breath === 'rest' || a.fainting || a.confusion || a.otherEmergency);
};

const EMERGENCIES = [
  // phrasing
  'feels like an elephant is sitting on my chest', 'there is a crushing pain in the middle of my chest', 'chest feels like its on fire',
  'I feel like I am suffocating', 'I keep blacking out', 'everything went black and I hit the floor', 'dad is not making sense and keeps asking where he is',
  'I am so short of breath I cannot finish a sentence', 'I cannot finish a sentence without gasping', 'no pain in my legs but my chest is killing me',
  'my husband collapsed and is not responding', 'Dad passed out in the kitchen', 'I feel like I am dying', 'she is unresponsive',
  // typos and look-alikes
  'cant brethe', 'chest paiin', 'faintd', 'chestpain', 'chest...pain', 'chst pain', 'I have ch​est pain', 'I have ch­est pain', 'I have ｃｈｅｓｔ ｐａｉｎ',
  'I have chеst pain', 'I have chest\npain', 'I have cheeeest paaaain', 'I have ch3st p4in', 'I have c.h.e.s.t p.a.i.n', 'I cant​ breathe',
  // other languages
  'mi esposo se cayó y no responde', 'mi mamá no despierta', 'siento que me muero', 'se me va a salir el corazón del pecho, me duele muchísimo',
  'Ba tôi ngã xuống và không trả lời', 'Tôi cảm thấy sắp chết', 'मेरी पत्नी गिर गई और जवाब नहीं दे रही', 'मुझे लगता है मैं मरने वाला हूँ',
  '我爸爸倒在地上叫不醒', '我觉得我要死了',
];
for (const text of EMERGENCIES) test(`emergency: ${JSON.stringify(text)}`, () => assert.equal(red(text), true));

const CALM = [
  'I am dying for a coffee', 'I am dying to know the results', 'my phone is not responding', 'I painted the fence', 'the weight gain is slowing',
  'I play chess every day', 'he is not breathing well today', '累死了，我快饿死了', 'bác sĩ không trả lời tôi', 'मैं मरीज हूँ', 'no hecho nada hoy',
  'what is the color of my pills', 'my paint is dry', 'ya lo he hecho', 'techo de mi casa',
];
for (const text of CALM) test(`calm: ${JSON.stringify(text)}`, () => assert.equal(red(text), false));

test('canonicalisation is fast on hostile input (no ReDoS)', () => {
  for (const text of ['a'.repeat(100000), 'chest '.repeat(16000), 'c.'.repeat(30000), 'e'.repeat(100000) + ' pain', '\n'.repeat(50000)]) {
    const t0 = performance.now();
    parser.parseFreeText(text);
    assert.ok(performance.now() - t0 < 1500, `${text.slice(0, 10)}… took ${performance.now() - t0} ms`);
  }
});

// ---- the model as a second opinion ----
let store, checkin, llm, modelCalls, modelAnswer;
const realFetch = globalThis.fetch;
before(async () => {
  store = await import('../src/store.js');
  checkin = await import('../src/core/checkin.js');
  llm = await import('../src/core/llm/index.js');
});
beforeEach(async () => {
  store.reset();
  llm._reset();
  modelCalls = 0;
  process.env.LLM_PROVIDER = 'lmstudio';
  globalThis.fetch = async (url, opts) => {
    if (String(url).endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }] }));
    if (String(url).endsWith('/v1/chat/completions')) {
      modelCalls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: modelAnswer(JSON.parse(opts.body)) } }] }));
    }
    return realFetch(url, opts);
  };
  await llm.detect({ force: true });
});
after(() => {
  globalThis.fetch = realFetch;
  process.env.LLM_PROVIDER = 'none';
});

const SLUMPED = 'Papa is slumped over in his chair and I cannot get him to open his eyes';
const says = (field, evidence) => () => JSON.stringify({ fields: { [field]: { value: true, evidence } }, textEn: '', injectionAttempt: false });

test('an English patient whose phrasing the rules miss is still escalated by the model second opinion', async () => {
  assert.equal(red(SLUMPED), false, 'precondition: the rules do not read this one');
  modelAnswer = says('unresponsive', 'cannot get him to open his eyes');
  const r = await checkin.handleUrgentFreeText(store.getPatient('p5'), SLUMPED);
  assert.ok(r?.[0]?.urgent, 'urgent reply');
  assert.ok(store.listAlerts('p5').some((a) => a.tier === 'RED'));
});

test('the model can add an emergency but never removes one the rules found', async () => {
  modelAnswer = () => JSON.stringify({ fields: { chestPain: { value: false, evidence: 'chest pain' } } });
  const r = await checkin.handleUrgentFreeText(store.getPatient('p5'), 'I have chest pain');
  assert.ok(r?.[0]?.urgent);
  assert.equal(modelCalls, 0, 'rules already decided: no model call');
});

test('questions and "if" sentences do not go to the model for en/es patients', async () => {
  modelAnswer = says('chestPain', 'chest pain');
  assert.equal(await checkin.handleUrgentFreeText(store.getPatient('p5'), 'What should I do if my dad passes by the pharmacy?'), null);
  assert.equal(modelCalls, 0);
});

test('a model that says nothing leaves a calm message calm', async () => {
  modelAnswer = () => JSON.stringify({ fields: {} });
  assert.equal(await checkin.handleUrgentFreeText(store.getPatient('p5'), 'thanks, see you tomorrow'), null);
});

test('with the model unhealthy (breaker open) rules still decide and nothing waits on the model', async () => {
  modelAnswer = () => new Promise(() => {});
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'm' }] }));
    return new Response('boom', { status: 500 });
  };
  llm._reset();
  await llm.detect({ force: true });
  for (let i = 0; i < 3; i++) await llm.complete('s', 'u');
  assert.equal(llm.enabled(), false);
  const t0 = Date.now();
  const r = await checkin.handleUrgentFreeText(store.getPatient('p5'), 'I keep blacking out');
  assert.ok(r?.[0]?.urgent);
  assert.ok(Date.now() - t0 < 500);
});
