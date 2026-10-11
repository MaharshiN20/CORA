// "what is heart failure" was answered with "I can help with questions about your heart, medicines,
// food and daily care. For anything else, please ask your family or care team." A 7B model had
// labelled the question "other" (not about health) and the companion believed it.
// A question with a word about health in it is never off-topic: the nurse gets it.
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-companion-offtopic-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, agent, i18n, llm;
const realFetch = globalThis.fetch;
before(async () => {
  store = await import('../src/store.js');
  agent = await import('../src/core/agent.js');
  i18n = await import('../src/core/i18n.js');
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

// A local model that calls every companion question "other" and answers every other prompt with nothing.
async function modelSaysOther() {
  process.env.LLM_PROVIDER = 'lmstudio';
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }] }));
    if (!u.endsWith('/v1/chat/completions')) throw new Error(`unexpected fetch ${u}`);
    const companion = JSON.parse(opts.body).messages[0].content.includes('discharge companion');
    const content = companion ? JSON.stringify({ category: 'other', covered: false, answer: '', sourceIds: [] }) : '';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  };
  await llm.detect({ force: true });
}

test('"what is heart failure" goes to the nurse even when the model calls it off-topic', async () => {
  await modelSaysOther();
  const r = await say('p5', 'what is heart failure');
  assert.equal(r[0].text, i18n.t('en', 'companion_nurse'));
  assert.equal(questions('p5').length, 1);
  assert.match(questions('p5')[0].title, /heart failure/i);
});

test('the same in Spanish', async () => {
  await modelSaysOther();
  const r = await say('p1', '¿Qué es la insuficiencia cardíaca?');
  assert.equal(r[0].text, i18n.t('es', 'companion_nurse'));
  assert.equal(questions('p1').length, 1);
});

test('a question that really is about something else still gets the "I can help with..." line', async () => {
  await modelSaysOther();
  const r = await say('p5', 'what is the capital of France?');
  assert.equal(r[0].text, i18n.t('en', 'companion_other'));
  assert.equal(questions('p5').length, 0);
});

test('a statement the model calls off-topic does not become a nurse task', async () => {
  await modelSaysOther();
  await say('p5', 'the hospital parking lot was full again');
  assert.equal(questions('p5').length, 0);
});
