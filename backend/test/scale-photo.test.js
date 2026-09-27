// Scale photo during the weight question (P3-13, first half): a vision model reads the display,
// code validates it, and the patient always confirms. Mocked provider; no network.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-test-scale-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, agent, llm;
const realFetch = globalThis.fetch;
let visionReply = {};
let sawImage = false;
before(async () => {
  store = await import('../src/store.js');
  agent = await import('../src/core/agent.js');
  llm = await import('../src/core/llm/index.js');
});
beforeEach(() => {
  store.reset();
  sawImage = false;
});
after(() => {
  globalThis.fetch = realFetch;
  process.env.LLM_PROVIDER = 'none';
  llm._reset();
});

async function useModel(id) {
  process.env.LLM_PROVIDER = 'lmstudio';
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id }] }));
    if (u.endsWith('/v1/chat/completions')) {
      const body = JSON.parse(opts.body);
      const content = body.messages[1].content;
      sawImage = Array.isArray(content) && content.some((c) => c.type === 'image_url' && c.image_url.url.startsWith('data:image/jpeg;base64,'));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(visionReply) } }] }));
    }
    return realFetch(url, opts);
  };
  llm._reset();
  await llm.detect({ force: true });
}
const photo = { base64: 'aGVsbG8=', mime: 'image/jpeg' };
async function atWeight(id = 'p5') {
  await agent.startCheckin(id);
  await agent.handleInbound({ patientId: id, buttonData: 'ci:rf:none' });
  assert.equal(store.getPatient(id).checkin.state, 'weight');
}

test('a vision model reads the scale; the patient confirms before it counts', async () => {
  visionReply = { display: '141.2', unit: 'lb', readable: true };
  await useModel('qwen2.5-vl-7b-instruct');
  await atWeight();
  const r = await agent.handleInbound({ patientId: 'p5', photo });
  assert.ok(sawImage, 'the photo was sent as an image to the model');
  assert.match(r[0].text, /I read 141.2 lb on your scale/);
  assert.deepEqual(r[0].buttons.flat().map((b) => b.data), ['ci:wconf:yes', 'ci:wconf:no']);
  assert.equal(store.getPatient('p5').checkin.answers.weightLb, undefined); // not yet
  await agent.handleInbound({ patientId: 'p5', buttonData: 'ci:wconf:yes' });
  assert.equal(store.getPatient('p5').checkin.answers.weightLb, 141.2);
  assert.ok(store.listAudit('p5').some((e) => e.type === 'scale_photo' && e.data.lb === 141.2));
});

test('kg on the display is converted; an unreadable photo asks the patient to type', async () => {
  visionReply = { display: '64.0', unit: 'kg', readable: true };
  await useModel('llava-1.6');
  await atWeight();
  let r = await agent.handleInbound({ patientId: 'p5', photo });
  assert.match(r[0].text, /141.1 lb/);

  store.reset();
  visionReply = { display: null, unit: null, readable: false };
  await atWeight();
  r = await agent.handleInbound({ patientId: 'p5', photo });
  assert.match(r[0].text, /couldn't read the numbers/);
});

test('a text-only model is never sent the image: the patient is asked to type', async () => {
  visionReply = { display: '141.2', unit: 'lb', readable: true };
  await useModel('qwen2.5-7b-instruct');
  await atWeight();
  const r = await agent.handleInbound({ patientId: 'p5', photo });
  assert.equal(sawImage, false);
  assert.match(r[0].text, /couldn't read the numbers/);
});

test('a photo outside the weight question is saved for the care team as before', async () => {
  await useModel('qwen2.5-vl-7b-instruct');
  const r = await agent.handleInbound({ patientId: 'p5', photo });
  assert.match(r[0].text, /saved it for your care team/);
  assert.equal(sawImage, false);
});
