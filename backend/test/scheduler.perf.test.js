// A demo-clock jump with a big backlog must not scan every retained job after every job
// (audit 2026-10-11: 9.8 s blocked at 500 patients).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-schedperf-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';

let scheduler, store, clock;
before(async () => {
  store = await import('../src/store.js');
  clock = await import('../src/core/clock.js');
  scheduler = await import('../src/core/scheduler.js');
  scheduler.defineJob('perf_noop', { run: async () => null });
});

test('1,500 due jobs on top of 15,000 retained ones run in well under a second per thousand', async () => {
  const jobs = store.collection('jobs');
  for (let i = 0; i < 15_000; i++) jobs.push({ id: `old${i}`, key: `old${i}`, kind: 'perf_noop', patientId: null, dueAt: '2020-01-01T00:00:00.000Z', status: 'done', payload: {} });
  const base = clock.now() + 3_600_000;
  for (let i = 0; i < 1_500; i++) scheduler.schedule({ kind: 'perf_noop', dueAt: base + i, key: `perf${i}` });
  clock.advance(7_200_000);
  const t0 = performance.now();
  const r = await scheduler.tick();
  const ms = performance.now() - t0;
  assert.equal(r.ran, 1_500);
  assert.ok(ms < 4_000, `took ${Math.round(ms)} ms`);
  clock.reset();
});

test('follow-ups scheduled by a running job that are already due still run in order', async () => {
  const order = [];
  scheduler.defineJob('perf_parent', {
    run: async (j) => {
      order.push(`parent${j.payload.n}`);
      scheduler.schedule({ kind: 'perf_child', dueAt: Date.parse(j.dueAt) + 1000, key: `child${j.payload.n}` });
    },
  });
  scheduler.defineJob('perf_child', { run: async (j) => order.push(j.key) });
  const t = clock.now() + 3_600_000;
  scheduler.schedule({ kind: 'perf_parent', dueAt: t, key: 'pp1', payload: { n: 1 } });
  scheduler.schedule({ kind: 'perf_parent', dueAt: t + 60_000, key: 'pp2', payload: { n: 2 } });
  clock.advance(7_200_000);
  await scheduler.tick();
  assert.deepEqual(order, ['parent1', 'child1', 'parent2', 'child2']);
  clock.reset();
});
