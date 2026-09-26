// P1-1: every time read in core follows the demo clock.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-clock-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, clock, agent, enroll, signals;
before(async () => {
  store = await import('../src/store.js');
  clock = await import('../src/core/clock.js');
  agent = await import('../src/core/agent.js');
  enroll = await import('../src/core/enroll.js');
  signals = await import('../src/core/signals.js');
});
beforeEach(() => store.reset());

const tap = (id, buttonData) => agent.handleInbound({ patientId: id, buttonData });
const say = (id, text) => agent.handleInbound({ patientId: id, text });

async function lowRiskCheckin(id, lb) {
  await agent.startCheckin(id);
  await say(id, String(lb));
  await tap(id, 'ci:breath:normal');
  await tap(id, 'ci:swell:none');
  await tap(id, 'ci:rf:none');
  await tap(id, 'ci:diu:yes');
}

test('check-in after a 1-day fast-forward lands on the new demo day', async () => {
  const beforeCount = store.getPatient('p5').weights.length;
  clock.advance(clock.DAY);
  await lowRiskCheckin('p5', 141);
  const p = store.getPatient('p5');
  // yesterday's seeded weight is kept, today's is appended on the demo date
  assert.equal(p.weights.length, beforeCount + 1);
  const last = p.weights.at(-1);
  assert.equal(last.ts.slice(0, 10), clock.nowISO().slice(0, 10));
  assert.equal(p.checkins.at(-1).ts.slice(0, 10), clock.nowISO().slice(0, 10));
  // 24h delta compares against the seeded "yesterday" (139.9), not a same-day value
  assert.equal(p.checkins.at(-1).weight.change24h, 1.1);
});

test('same demo day twice replaces the weight instead of duplicating it', async () => {
  clock.advance(clock.DAY);
  await lowRiskCheckin('p5', 141);
  await lowRiskCheckin('p5', 140.5);
  const days = store.getPatient('p5').weights.map((w) => w.ts.slice(0, 10));
  assert.equal(new Set(days).size, days.length);
  assert.equal(store.getPatient('p5').weights.at(-1).lb, 140.5);
});

test('messages, alerts and audit are stamped with demo time', async () => {
  clock.advance(3 * clock.DAY);
  await say('p5', 'chest pain');
  const today = clock.nowISO().slice(0, 10);
  assert.equal(store.listMessages('p5').at(-1).ts.slice(0, 10), today);
  assert.equal(store.listAlerts()[0].ts.slice(0, 10), today);
});

test('judge clone made after a fast-forward keeps a current weight trend', () => {
  clock.advance(5 * clock.DAY);
  const p = enroll.enrollDemoPatient({ language: 'en' });
  assert.equal(p.weights.at(-1).ts.slice(0, 10), clock.nowISO().slice(0, 10));
  assert.equal(signals.getSignals(p).weightDelta24h, 2.7); // Maria's story still trips the 24h rule
  assert.equal(signals.getSignals(p).daysSinceDischarge, 6);
});

test('demo clock offset survives a store reload (persisted in db)', async () => {
  clock.advance(2 * clock.HOUR);
  store.persist();
  assert.equal(store.raw().clockOffsetMs, 2 * clock.HOUR);
});
