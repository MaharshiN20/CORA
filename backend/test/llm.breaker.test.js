// S5 (audit 2026-10-11): a hung, slow or erroring model must behave like "no model" after a
// couple of failures, instead of costing every patient message the full timeout again.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLM_PROVIDER = 'none';
process.env.LLM_BREAKER_OPEN_MS = '200';
const llm = await import('../src/core/llm/index.js');

let calls = 0;
const provider = (chat) => ({ name: 'fake', model: 'm', chat: async (o) => (calls++, chat(o)) });
beforeEach(() => {
  llm._reset();
  calls = 0;
});

test('two timeouts open the breaker: enabled() is false and complete() returns null without calling the model', async () => {
  llm._use([provider(() => new Promise(() => {}))]); // hangs forever
  assert.equal(llm.enabled(), true);
  const t0 = Date.now();
  assert.equal(await llm.complete('s', 'u', 50, { deadlineMs: 40 }), null);
  assert.equal(await llm.complete('s', 'u', 50, { deadlineMs: 40 }), null);
  assert.equal(llm.enabled(), false, 'unhealthy = no model');
  assert.equal(llm.status().unhealthy, true);
  const before = calls;
  assert.equal(await llm.complete('s', 'u', 50, { deadlineMs: 40 }), null);
  assert.equal(calls, before, 'no call while open');
  assert.ok(Date.now() - t0 < 1000);
});

test('5xx errors count; a 400 (our request was refused) does not', async () => {
  llm._use([provider(() => Promise.reject(Object.assign(new Error('bad request'), { status: 400 })))]);
  for (let i = 0; i < 4; i++) await llm.complete('s', 'u');
  assert.equal(llm.enabled(), true);
  llm._use([provider(() => Promise.reject(Object.assign(new Error('boom'), { status: 500 })))]);
  await llm.complete('s', 'u');
  await llm.complete('s', 'u');
  assert.equal(llm.enabled(), false);
});

test('after the window one call goes through; success closes the breaker, failure reopens it', async () => {
  let healthy = false;
  llm._use([provider(() => (healthy ? 'ok' : Promise.reject(Object.assign(new Error('boom'), { status: 503 }))))]);
  await llm.complete('s', 'u');
  await llm.complete('s', 'u');
  assert.equal(llm.enabled(), false);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(llm.enabled(), true, 'half-open');
  assert.equal(await llm.complete('s', 'u'), null); // probe fails -> reopens at once
  assert.equal(llm.enabled(), false);
  await new Promise((r) => setTimeout(r, 250));
  healthy = true;
  assert.equal(await llm.complete('s', 'u'), 'ok');
  assert.equal(llm.enabled(), true);
});

test('a late success after the deadline does not count as health', async () => {
  llm._use([provider(() => new Promise((r) => setTimeout(() => r('late'), 120)))]);
  await llm.complete('s', 'u', 50, { deadlineMs: 30 });
  await llm.complete('s', 'u', 50, { deadlineMs: 30 });
  await new Promise((r) => setTimeout(r, 140)); // both stragglers finish "successfully"
  assert.equal(llm.enabled(), false);
});

test('a caller aborting its own request is not an outage', async () => {
  llm._use([provider(() => new Promise(() => {}))]);
  const ac = new AbortController();
  const p = llm.complete('s', 'u', 50, { deadlineMs: 60, signal: ac.signal });
  ac.abort();
  await p;
  await llm.complete('s', 'u', 50, { deadlineMs: 60, signal: AbortSignal.abort() });
  assert.equal(llm.enabled(), true);
});
