// Phase 3: device readings go through triage (SpO2, heart rate, weight), with validation,
// idempotency and alert de-bouncing so a chatty oximeter can't flood the worklist.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-devtriage-${process.pid}.json`);
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
beforeEach(() => {
  store.reset();
  delete process.env.DEVICE_KEY;
  delete process.env.API_TOKEN;
});

const post = async (body, headers = {}) => {
  const r = await fetch(`${base}/api/devices/readings`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const reading = (patientId, type, value, extra = {}) => post({ patientId, type, value, device: 'test', ...extra });
const alerts = (id) => store.listAlerts().filter((a) => a.patientId === id && a.source === 'device reading');

test('SpO2 below 90 is RED: an alert, and the patient is told to call 911', async () => {
  const before = store.listMessages('p3').length;
  const res = await reading('p3', 'spo2', 88);
  assert.equal(res.status, 201);
  assert.equal(res.body.tier, 'RED');
  const a = alerts('p3');
  assert.equal(a.length, 1);
  assert.equal(a[0].tier, 'RED');
  assert.match(a[0].reasons[0], /SpO2 88%/);
  const out = store.listMessages('p3').slice(before).filter((m) => m.direction === 'out' && m.to === 'patient');
  assert.ok(out.length >= 1, 'patient was messaged');
  assert.equal(store.getPatient('p3').lastTier, 'RED');
});

test('SpO2 90-92 is YELLOW, 95 raises nothing', async () => {
  assert.equal((await reading('p5', 'spo2', 91)).body.tier, 'YELLOW');
  assert.equal(alerts('p5')[0].tier, 'YELLOW');
  store.reset();
  assert.equal((await reading('p5', 'spo2', 95)).body.tier, 'GREEN');
  assert.equal(alerts('p5').length, 0);
});

test('COPD patients: 89% is YELLOW, 86% is RED', async () => {
  store.updatePatient('p2', { profile: { ...store.getPatient('p2').profile, copd: true } });
  assert.equal((await reading('p2', 'spo2', 89)).body.tier, 'YELLOW');
  store.reset();
  store.updatePatient('p2', { profile: { ...store.getPatient('p2').profile, copd: true } });
  assert.equal((await reading('p2', 'spo2', 86)).body.tier, 'RED');
});

test('heart rate outside 50-120 is YELLOW', async () => {
  assert.equal((await reading('p2', 'hr', 135)).body.tier, 'YELLOW');
  store.reset();
  assert.equal((await reading('p2', 'hr', 42)).body.tier, 'YELLOW');
  store.reset();
  assert.equal((await reading('p2', 'hr', 72)).body.tier, 'GREEN');
});

test('a device weight joins the patient weight history and triggers the weight rules', async () => {
  const last = store.getPatient('p2').weights.at(-1);
  clock.advance(24 * clock.HOUR);
  const res = await reading('p2', 'weight', last.lb + 3);
  assert.equal(res.body.tier, 'YELLOW');
  assert.equal(store.getPatient('p2').weights.at(-1).lb, last.lb + 3);
  assert.match(alerts('p2')[0].reasons[0], /Weight up/);
});

test('a second reading in the same hour joins the open device alert instead of making another', async () => {
  await reading('p3', 'spo2', 88);
  await reading('p3', 'spo2', 87);
  await reading('p3', 'spo2', 86);
  const a = alerts('p3');
  assert.equal(a.length, 1, 'one alert, not three');
  assert.ok(a[0].reasons.some((r) => /87%/.test(r)) && a[0].reasons.some((r) => /86%/.test(r)));
});

test('a worse reading escalates a YELLOW into a RED alert', async () => {
  await reading('p3', 'spo2', 91);
  await reading('p3', 'spo2', 85);
  assert.deepEqual(alerts('p3').map((a) => a.tier).sort(), ['RED', 'YELLOW']);
});

test('readingId makes a retry idempotent: same id -> same reading, one alert, no second row', async () => {
  const a = await reading('p3', 'spo2', 88, { readingId: 'dev-1' });
  const b = await reading('p3', 'spo2', 88, { readingId: 'dev-1' });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.body.id, a.body.id);
  assert.equal(store.listReadings('p3', 'spo2').length, 1);
  assert.equal(alerts('p3').length, 1);
});

test('input validation: ts, device, readingId and patientId types', async () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const old = new Date(Date.now() - 40 * 864e5).toISOString();
  assert.equal((await reading('p2', 'hr', 70, { ts: future })).status, 400);
  assert.equal((await reading('p2', 'hr', 70, { ts: old })).status, 400);
  assert.equal((await reading('p2', 'hr', 70, { ts: 'garbage' })).status, 400);
  assert.equal((await reading('p2', 'hr', 70, { device: { a: 1 } })).status, 400);
  assert.equal((await reading('p2', 'hr', 70, { device: 'd'.repeat(41) })).status, 400);
  assert.equal((await reading('p2', 'hr', 70, { readingId: 'x'.repeat(100) })).status, 400);
  assert.equal((await post({ patientId: { nope: 1 }, type: 'hr', value: 70 })).status, 404);
  assert.equal((await reading('p2', 'hr', true)).status, 400, 'booleans are not numbers');
  assert.equal((await reading('p2', 'hr', '')).status, 400);
  assert.equal(store.listReadings('p2').length, 0, 'rejected readings were not stored');
  assert.equal((await reading('p2', 'hr', 70, { ts: new Date(Date.now() - 3600_000).toISOString() })).status, 201, 'a recent past ts is fine');
});

test('DEVICE_KEY: when set, the readings endpoint needs x-device-key, and the key opens nothing else', async () => {
  process.env.DEVICE_KEY = 'scale-key';
  assert.equal((await post({ patientId: 'p2', type: 'hr', value: 70 })).status, 401);
  assert.equal((await post({ patientId: 'p2', type: 'hr', value: 70 }, { 'x-device-key': 'wrong' })).status, 401);
  assert.equal((await post({ patientId: 'p2', type: 'hr', value: 70 }, { 'x-device-key': 'scale-key' })).status, 201);
  process.env.API_TOKEN = 'nurse-token';
  assert.equal((await post({ patientId: 'p2', type: 'hr', value: 71 }, { 'x-device-key': 'scale-key' })).status, 201, 'a device does not need the nurse token');
  assert.equal((await post({ patientId: 'p2', type: 'hr', value: 72 })).status, 401);
  const r = await fetch(`${base}/api/patients`, { headers: { 'x-device-key': 'scale-key' } });
  assert.equal(r.status, 401);
});

test('ranges come from one place (integrations/devices.js)', async () => {
  const devices = await import('../src/integrations/devices.js');
  assert.deepEqual(devices.RANGES.spo2, [50, 100]);
  assert.equal((await reading('p2', 'spo2', 49)).status, 400);
  assert.equal((await reading('p2', 'weight', 701)).status, 400);
});
