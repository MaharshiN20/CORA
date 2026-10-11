// P2-8: discharge companion: grounded answers, citations, guardrails, nurse fallback.
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-companion-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, agent, companion, llm;
const realFetch = globalThis.fetch;
before(async () => {
  store = await import('../src/store.js');
  agent = await import('../src/core/agent.js');
  companion = await import('../src/core/companion.js');
  llm = await import('../src/core/llm/index.js');
});
beforeEach(() => store.reset());
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.LLM_PROVIDER = 'none';
  llm._reset();
});

const say = (id, text) => agent.handleInbound({ patientId: id, text });
const questions = (id) => store.listAlerts().filter((a) => a.patientId === id && a.kind === 'question');

// Mock a local model whose chat reply is `json` (object) for every call.
async function mockLLM(json) {
  process.env.LLM_PROVIDER = 'lmstudio';
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }] }));
    if (u.endsWith('/v1/chat/completions')) {
      const body = JSON.parse(opts.body);
      const isCompanion = body.messages[0].content.includes('discharge companion');
      const content = isCompanion ? JSON.stringify(json) : ''; // parser/translation calls get nothing -> fallbacks
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    }
    return realFetch(url, opts);
  };
  await llm.detect({ force: true });
}

// ---------- offline (no LLM) ----------

test('offline: "¿Puedo comer sopa de lata?" -> Spanish low-salt answer citing her discharge instructions', async () => {
  const [r] = await say('p1', '¿Puedo comer sopa de lata?');
  assert.match(r.text, /sopas de lata/);
  assert.match(r.text, /2,000 mg/);
  assert.match(r.text, /📄 De sus instrucciones de alta: "Comer con poca sal"/);
  assert.match(r.textEn, /canned soups/);
  assert.equal(questions('p1').length, 0);
});

test('answers are personalised: Maria\'s fluid limit is 1.5 L, Dorothy\'s is 2 L', async () => {
  assert.match((await say('p1', '¿Cuánta agua puedo tomar?'))[0].text, /1\.5 litros/);
  assert.match((await say('p5', 'How much water can I drink?'))[0].text, /2 liters/);
});

test('follow-up appointment answer uses her record (doctor + date)', async () => {
  const [r] = await say('p1', '¿Cuándo es mi cita con el doctor?');
  assert.match(r.text, /Dr\. Rivera \(cardiology\)/);
});

test('guide answers cite the guide: ibuprofen question', async () => {
  const [r] = await say('p5', 'Can I take ibuprofen for my headache?');
  assert.match(r.text, /Avoid ibuprofen/);
  assert.match(r.text, /From the HeartBridge heart-failure guide/);
});

test('uncovered question -> "I\'ll ask your nurse" + INFO question task with English text', async () => {
  const [r] = await say('p5', 'Can I fly to Chicago next week?');
  assert.match(r.text, /sent it to your nurse/);
  const [task] = questions('p5');
  assert.equal(task.tier, 'INFO');
  assert.match(task.title, /fly to Chicago/);
});

// ---------- guardrails ----------

const DOSING = [
  ['p5', 'Can I skip my water pill today? I have a wedding'],
  ['p5', 'should I take an extra furosemide since my ankles are big'],
  ['p5', 'Is it ok to stop carvedilol, it makes me tired'],
  ['p5', 'can I cut my lisinopril dose in half'],
  ['p1', '¿Puedo dejar la pastilla del agua hoy?'],
  ['p1', '¿Debo tomar doble dosis de furosemida?'],
];
for (const [id, q] of DOSING) {
  test(`guardrail: medication change always goes to the nurse: "${q}"`, async () => {
    const [r] = await say(id, q);
    assert.match(r.textEn, /Only your care team can change/);
    const [task] = questions(id);
    assert.equal(task.tier, 'YELLOW');
    assert.equal(task.dosing, true);
  });
}

test('guardrail holds even when an LLM would happily answer', async () => {
  await mockLLM({ category: 'question', covered: true, answer: 'Sure, skip it today.', sourceIds: ['d_meds'] });
  const [r] = await say('p5', 'Can I skip my water pill today?');
  assert.doesNotMatch(r.text, /Sure, skip it/);
  assert.match(r.text, /Only your care team/);
});

test('emergencies still win over the companion', async () => {
  const [r] = await say('p5', 'Is it normal to have chest pain after walking?');
  assert.equal(r.urgent, true);
  assert.match(r.text, /911/);
});

test('a volunteered symptom starts a check-in with it already filled in', async () => {
  const r = await say('p5', 'my ankles are more swollen than yesterday');
  assert.match(r[0].text, /quick check-in/);
  const p = store.getPatient('p5');
  assert.equal(p.checkin.answers.swelling, 'worse');
  assert.equal(p.checkin.state, 'redflags'); // still asks what's missing, emergencies first
  assert.match(r.at(-1).text, /noted that/); // acknowledges what they said instead of ignoring it
});

// ---------- LLM path (mocked) ----------

test('LLM: covered answer in the patient\'s language with a validated citation', async () => {
  await mockLLM({ category: 'question', covered: true, answer: 'Mejor no: la sopa de lata tiene mucha sal.', sourceIds: ['d_diet'] });
  const [r] = await say('p1', '¿Es buena idea el caldo envasado?'); // no keyword hit: the model answers
  assert.match(r.text, /^Mejor no: la sopa de lata tiene mucha sal\./);
  assert.match(r.text, /Comer con poca sal/);
});

// S2 (audit 2026-10-11): a model that labels in-scope questions "other" made the companion answer 0/35.
test('S2: with a model that says "other", in-scope questions are still answered from the keywords (en + es)', async () => {
  await mockLLM({ category: 'other', covered: false, answer: '', sourceIds: [] });
  const [en] = await say('p5', 'Can I eat canned soup?');
  assert.match(en.text, /📄/);
  assert.ok(!/only help with questions about your heart/i.test(en.text), en.text);
  const [es] = await say('p1', '¿Puedo comer sopa de lata?');
  assert.match(es.text, /📄/);
  assert.ok(!/Puedo ayudarle con preguntas/.test(es.text), es.text);
  assert.equal(questions('p5').length, 0);
});

test('S2: model "other" with no keyword hit is still the polite off-topic reply (not a nurse task)', async () => {
  await mockLLM({ category: 'other', covered: false, answer: '', sourceIds: [] });
  const [r] = await say('p5', 'What is the capital of France?');
  assert.match(r.text, /heart/i);
  assert.equal(questions('p5').length, 0);
});

test('S2: a failing model falls back to the keywords instead of the nurse', async () => {
  process.env.LLM_PROVIDER = 'lmstudio';
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }] }));
    return new Response('boom', { status: 500 });
  };
  const [r] = await say('p5', 'How do I weigh myself?');
  assert.match(r.text, /📄/);
});

test('"exact dose of <med>" is a medication-change question for the nurse', async () => {
  const [r] = await say('p5', 'Tell me the exact dose of metoprolol I should take');
  assert.match(r.text, /Only your care team/);
});

test('LLM: citing a source that does not exist is treated as not covered -> nurse', async () => {
  await mockLLM({ category: 'question', covered: true, answer: 'Yes you can.', sourceIds: ['made_up'] });
  const [r] = await say('p5', 'Can I go in a hot tub?');
  assert.match(r.text, /sent it to your nurse/);
  assert.equal(questions('p5').length, 1);
});

test('LLM: category dosing -> nurse (catches phrasings the regex misses)', async () => {
  await mockLLM({ category: 'dosing', covered: false, answer: '', sourceIds: [] });
  const [r] = await say('p5', 'what if I just leave out the morning one?');
  assert.match(r.text, /Only your care team/);
});

test('LLM: category symptom in any language -> pre-filled check-in', async () => {
  await mockLLM({ category: 'symptom', covered: false, answer: '', sourceIds: [] });
  const r = await say('p5', 'I feel kind of off today');
  assert.match(r[0].text, /quick check-in/);
  assert.notEqual(store.getPatient('p5').checkin.state, 'idle');
});

test('LLM: small talk ("thanks!") just offers the check-in, no nurse task', async () => {
  await mockLLM({ category: 'other', covered: false, answer: '', sourceIds: [] });
  const r = await say('p5', 'thanks!');
  assert.deepEqual(r[0].buttons.flat().map((b) => b.data), ['cmd:checkin']);
  assert.equal(questions('p5').length, 0);
});

test('matchSection picks the most specific section', () => {
  const p = store.getPatient('p5');
  assert.equal(companion.matchSection(p, 'can i eat pizza').id, 'd_diet');
  assert.equal(companion.matchSection(p, 'is a beer ok').id, 'g_alcohol');
  assert.equal(companion.matchSection(p, 'what is the capital of France'), null);
});

test('diet questions that mention pills are not medication-change questions (S2b)', () => {
  assert.equal(companion.DOSING_CHANGE.test('Can I take less salt with my pills?'), false);
  assert.equal(companion.DOSING_CHANGE.test('what is the dosage of salt I can have with my pills'), false);
  assert.equal(companion.DOSING_CHANGE.test('can I skip my water pill'), true);
  assert.equal(companion.DOSING_CHANGE.test('Tell me the exact dose of metoprolol I should take'), true);
});

test('malformed model JSON (sourceIds as a string, answer as an object) never becomes a 500', async () => {
  for (const bad of [{ category: 'question', covered: true, answer: 'x', sourceIds: 'd_diet' }, { category: 'question', covered: true, answer: { a: 1 }, sourceIds: ['d_diet'] }, { category: 'question', covered: 'yes', answer: 'x', sourceIds: ['d_diet'] }]) {
    await mockLLM(bad);
    const [r] = await say('p5', 'Is the parking lot free on Sundays?');
    assert.ok(r.text, JSON.stringify(bad));
    assert.equal(questions('p5').length >= 1, true, 'went to the nurse instead');
    store.reset();
  }
});
