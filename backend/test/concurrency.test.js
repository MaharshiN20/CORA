// Phase 2: messages for one patient are processed one at a time; retries are deduplicated.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-concurrency-${process.pid}.json`);
process.env.LLM_PROVIDER = 'lmstudio';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, agent, llm;
const realFetch = globalThis.fetch;
let llmDelayMs = 0;
let llmCalls = 0;

before(async () => {
  store = await import('../src/store.js');
  agent = await import('../src/core/agent.js');
  llm = await import('../src/core/llm/index.js');
  // A slow local model: this is what widens the race window in real life.
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }] }));
    if (u.endsWith('/v1/chat/completions')) {
      llmCalls++;
      await new Promise((r) => setTimeout(r, llmDelayMs));
      return Response.json({ choices: [{ message: { content: '{}' } }] });
    }
    return realFetch(url, init);
  };
  await llm.detect({ force: true });
});
after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  store.reset();
  agent.resetInboundDedup();
  llmDelayMs = 0;
  llmCalls = 0;
});

test('withPatientLock runs one patient\'s work in order, other patients in parallel', async () => {
  const log = [];
  const job = (id, name, ms) => agent.withPatientLock(id, async () => {
    log.push(`${name}:start`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`${name}:end`);
  });
  await Promise.all([job('a', 'a1', 30), job('a', 'a2', 1), job('b', 'b1', 5)]);
  assert.ok(log.indexOf('a1:end') < log.indexOf('a2:start'), 'a2 waits for a1');
  assert.ok(log.indexOf('b1:start') < log.indexOf('a1:end'), 'another patient is not blocked');
});

test('a failing job does not block the next one', async () => {
  const failing = agent.withPatientLock('x', async () => {
    throw new Error('boom');
  });
  await assert.rejects(failing, /boom/);
  assert.equal(await agent.withPatientLock('x', async () => 'ok'), 'ok');
});

test('a repeated provider message id is processed once and gets the same replies', async () => {
  const msg = { patientId: 'p1', channel: 'sms', messageId: 'SM123', text: 'hola' };
  const [a, b] = await Promise.all([agent.handleInbound(msg), agent.handleInbound(msg)]);
  assert.deepEqual(a, b);
  const inbound = store.listMessages('p1').filter((m) => m.direction === 'in');
  assert.equal(inbound.length, 1, 'one inbound row, not two');
  const c = await agent.handleInbound(msg); // later retry
  assert.deepEqual(c, a);
  assert.equal(store.listMessages('p1').filter((m) => m.direction === 'in').length, 1);
});

test('different message ids, or none, are never merged', async () => {
  await agent.handleInbound({ patientId: 'p1', channel: 'sms', messageId: 'A', text: 'hola' });
  await agent.handleInbound({ patientId: 'p1', channel: 'sms', messageId: 'B', text: 'hola' });
  await agent.handleInbound({ patientId: 'p1', channel: 'sim', text: 'hola' });
  await agent.handleInbound({ patientId: 'p1', channel: 'sim', text: 'hola' });
  assert.equal(store.listMessages('p1').filter((m) => m.direction === 'in').length, 4);
});

test('startCheckin queues behind an inbound message for the same patient', async () => {
  llmDelayMs = 60;
  const order = [];
  const inbound = agent.handleInbound({ patientId: 'p1', text: 'me siento cansada' }).then(() => order.push('inbound'));
  const start = agent.startCheckin('p1').then(() => order.push('start'));
  await Promise.all([inbound, start]);
  assert.deepEqual(order, ['inbound', 'start']);
});
