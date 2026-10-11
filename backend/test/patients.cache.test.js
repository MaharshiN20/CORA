// GET /api/patients reuses its live-risk list until something changes (audit 2026-10-11: it was
// recomputed for every patient on every read).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-pcache-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, clock, server, base;
before(async () => {
  store = await import('../src/store.js');
  clock = await import('../src/core/clock.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());
const list = async () => (await fetch(`${base}/api/patients`)).json();

test('revision() moves on every change', () => {
  const r = store.revision();
  store.updatePatient('p1', { notes: 'x' });
  assert.ok(store.revision() > r);
});

test('a change shows up on the very next read; an unchanged store gives the same answer', async () => {
  const a = await list();
  const b = await list();
  assert.deepEqual(a, b);
  const p = store.getPatient('p1');
  store.updatePatient('p1', { weights: [...p.weights, { ts: clock.nowISO(), lb: p.weights.at(-1).lb + 6 }] });
  const c = await list();
  const before = a.find((x) => x.id === 'p1');
  const after = c.find((x) => x.id === 'p1');
  assert.equal(after.weights.length, before.weights.length + 1);
  assert.notEqual(after.riskScore, before.riskScore);
});

test('moving the clock a day also refreshes it', async () => {
  const a = await list();
  clock.advance(24 * 60 * 60 * 1000);
  const b = await list();
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
  clock.reset();
});
