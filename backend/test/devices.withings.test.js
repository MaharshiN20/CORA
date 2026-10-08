// K10: the Withings webhook. Signature over the raw body, measures -> the same path as
// POST /api/devices/readings, idempotent on the Withings group id. Fully offline.
import { test, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-devices-withings-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/withings/getmeas.json', import.meta.url), 'utf8'));
const SECRET = 'withings-client-secret';
const USER = FIXTURE.userid;
const PID = 'p3'; // no COPD, so the standard SpO2 thresholds apply

let store, clock, devices, hooks, security, server, base;

before(async () => {
  store = await import('../src/store.js');
  clock = await import('../src/core/clock.js');
  devices = await import('../src/integrations/devices.js');
  hooks = await import('../src/routes/webhooks.js');
  security = await import('../src/security.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

let warn;
beforeEach(() => {
  store.reset();
  security.resetRateLimits();
  hooks.linkDevice('withings', USER, PID);
  process.env.WITHINGS_CLIENT_SECRET = SECRET;
  warn = console.warn;
  console.warn = () => {};
});
afterEach(() => {
  console.warn = warn;
  delete process.env.WITHINGS_CLIENT_SECRET;
  delete process.env.NODE_ENV;
});

// The fixture's groups, stamped "a minute ago" so the freshness rules see a current reading.
const fresh = (patch = (g) => g) => ({ ...FIXTURE, measuregrps: FIXTURE.measuregrps.map((g) => patch({ ...g, date: Math.floor(clock.now() / 1000) - 60 })) });
const group = (grpid, measures, extra = {}) => ({ grpid, attrib: 0, category: 1, date: Math.floor(clock.now() / 1000) - 60, measures, ...extra });
const kg = (value) => ({ value: Math.round(value * 1000), type: 1, unit: -3 });

// Sends `raw` exactly as given; signs it unless told otherwise.
async function deliver(payload, { raw = JSON.stringify(payload), signature = devices.withingsSignature(raw, SECRET), contentType = 'application/json' } = {}) {
  const res = await fetch(`${base}/webhooks/withings`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, ...(signature !== null && { 'X-Withings-Signature': signature }) },
    body: raw,
  });
  return { status: res.status, body: await res.json() };
}

const readings = (id = PID) => store.listReadings(id);
const deviceAlerts = (id = PID) => store.listAlerts().filter((a) => a.patientId === id && a.source === 'device reading');

// ---------- verifyWithingsSignature ----------
test('signature: HMAC-SHA256 of the exact bytes verifies; the header may be prefixed or upper-case', () => {
  const body = '{"userid":1,"measuregrps":[]}';
  const sig = devices.withingsSignature(body, SECRET);
  assert.match(sig, /^[0-9a-f]{64}$/);
  const ok = (header, raw = body, secret = SECRET) => devices.verifyWithingsSignature(raw, { 'x-withings-signature': header }, secret);
  assert.equal(ok(sig), true);
  assert.equal(ok(`sha256=${sig}`), true);
  assert.equal(ok(sig.toUpperCase()), true);
  assert.equal(ok(sig, Buffer.from(body)), true, 'a Buffer and its string hash the same');
});

test('signature: anything else is refused', () => {
  const body = '{"userid":1,"measuregrps":[]}';
  const sig = devices.withingsSignature(body, SECRET);
  const verify = (raw, headers, secret = SECRET) => devices.verifyWithingsSignature(raw, headers, secret);
  assert.equal(verify(`${body} `, { 'x-withings-signature': sig }), false, 'one extra byte');
  assert.equal(verify(body, { 'x-withings-signature': sig }, 'other-secret'), false);
  assert.equal(verify(body, { 'x-withings-signature': `${sig.slice(0, -1)}${sig.at(-1) === '0' ? '1' : '0'}` }), false, 'one hex digit off');
  assert.equal(verify(body, {}), false, 'no header');
  assert.equal(verify(body, undefined), false);
  assert.equal(verify(body, { 'x-withings-signature': '' }), false);
  assert.equal(verify(body, { 'x-withings-signature': 'abc123' }), false, 'too short to be a digest');
  assert.equal(verify(body, { 'x-withings-signature': 'z'.repeat(64) }), false, 'not hex');
  assert.equal(verify(body, { 'x-withings-signature': ['a', 'b'] }), false, 'a repeated header');
  assert.equal(verify(body, { 'x-withings-signature': sig }, ''), false, 'an empty secret never verifies');
  assert.equal(verify(null, { 'x-withings-signature': sig }), false);
});

// ---------- withingsReadings (pure mapping) ----------
test('mapping: kg becomes lb, pulse and SpO2 pass through, other measure types are skipped', () => {
  const out = devices.withingsReadings(FIXTURE);
  assert.equal(out.userId, '13371337');
  assert.deepEqual(out.rejected, []);
  assert.deepEqual(
    out.readings.map((r) => [r.type, r.value, r.readingId]),
    [
      ['weight', 177.5, 'withings:5550001:1'], // 80.5 kg
      ['hr', 72, 'withings:5550001:11'],
      ['spo2', 96, 'withings:5550002:54'],
    ],
  );
  assert.equal(out.readings[0].ts, new Date(1759900000 * 1000).toISOString());
});

test('mapping: the unit exponent is applied', () => {
  const one = (m) => devices.withingsReadings({ userid: 1, measuregrps: [{ grpid: 1, date: 1759900000, measures: [m] }] }).readings[0]?.value;
  assert.equal(one({ value: 805, type: 1, unit: -1 }), 177.5);
  assert.equal(one({ value: 80, type: 1, unit: 0 }), 176.4);
  assert.equal(one({ value: 9650, type: 54, unit: -2 }), 96.5);
  assert.equal(one({ value: 72, type: 11 }), 72, 'unit defaults to 0');
});

test('mapping: groups that cannot be trusted are rejected with a reason', () => {
  const g = (extra) => ({ grpid: 9, attrib: 0, category: 1, date: 1759900000, measures: [{ value: 80500, type: 1, unit: -3 }], ...extra });
  const reasons = (extra) => {
    const out = devices.withingsReadings({ userid: 1, measuregrps: [g(extra)] });
    assert.equal(out.readings.length, 0, JSON.stringify(extra));
    return out.rejected.map((r) => r.reason).join();
  };
  assert.match(reasons({ attrib: 1 }), /could not tell who/, 'someone else may have stepped on the scale');
  assert.match(reasons({ category: 2 }), /goal/, 'a target weight is not a weight');
  assert.match(reasons({ grpid: undefined }), /group id/, 'no id: a retry could not be recognised');
  assert.match(reasons({ grpid: 'x'.repeat(60) }), /group id/, 'an id that would not fit a readingId');
  assert.match(reasons({ date: undefined }), /date/);
  assert.match(reasons({ measures: [{ value: 'heavy', type: 1, unit: -3 }] }), /not a number/);
  assert.match(reasons({ measures: [{ value: 8, type: 1, unit: 40 }] }), /not a number/, 'an absurd exponent');
  assert.equal(devices.withingsReadings({ userid: 1, measuregrps: [g({ attrib: 2 })] }).readings.length, 1, 'a manual entry by the patient counts');
});

test('mapping: a payload without measure groups is an error, not an empty success', () => {
  for (const bad of [null, {}, { measuregrps: 'x' }, { userid: 1 }]) assert.throws(() => devices.withingsReadings(bad), /measuregrps/);
  assert.deepEqual(devices.withingsReadings({ userid: 1, measuregrps: [] }), { userId: '1', readings: [], rejected: [] });
});

// ---------- the route ----------
test('a signed delivery stores each measure as a device reading and runs the triage rules', async () => {
  const res = await deliver(fresh());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.rejected, []);
  assert.equal(res.body.duplicates, 0);
  assert.deepEqual(
    res.body.accepted.map((a) => [a.type, a.value, a.readingId, a.tier]),
    [
      ['weight', 177.5, 'withings:5550001:1', res.body.accepted[0].tier],
      ['hr', 72, 'withings:5550001:11', 'GREEN'],
      ['spo2', 96, 'withings:5550002:54', 'GREEN'],
    ],
  );
  const stored = readings();
  assert.equal(stored.length, 3);
  assert.ok(stored.every((r) => r.source === 'device' && r.device === 'withings'));
  assert.equal(store.getPatient(PID).weights.at(-1).lb, 177.5, 'the weight joined the weight history');
  assert.equal(store.listAudit(PID).filter((e) => e.type === 'device_reading').length, 3);
});

test('same rules as POST /api/devices/readings: SpO2 88 is RED and the patient is told to call 911', async () => {
  const before = store.listMessages(PID).length;
  const res = await deliver({ userid: USER, measuregrps: [group(70001, [{ value: 88, type: 54, unit: 0 }])] });
  assert.equal(res.body.accepted[0].tier, 'RED');
  assert.equal(deviceAlerts().length, 1);
  assert.equal(deviceAlerts()[0].tier, 'RED');
  assert.ok(store.listMessages(PID).slice(before).some((m) => m.direction === 'out' && m.to === 'patient'));
  // the same reading through the API endpoint gives the same verdict
  const api = await fetch(`${base}/api/devices/readings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patientId: 'p5', type: 'spo2', value: 88 }) });
  assert.equal((await api.json()).tier, 'RED');
  // and the patient's own profile is honoured: for Robert (COPD) 88% is YELLOW, as in a check-in
  hooks.linkDevice('withings', 2002, 'p2');
  const copd = await deliver({ userid: 2002, measuregrps: [group(70010, [{ value: 88, type: 54, unit: 0 }])] });
  assert.equal(copd.body.accepted[0].tier, 'YELLOW');
});

test('a tampered body is rejected with 403 and nothing is stored', async () => {
  const raw = JSON.stringify(fresh());
  const signature = devices.withingsSignature(raw, SECRET);
  const tampered = raw.replace('80500', '60500'); // hide a weight gain
  assert.notEqual(tampered, raw);
  assert.deepEqual(await deliver(null, { raw: tampered, signature }), { status: 403, body: { error: 'invalid signature' } });
  assert.equal(readings().length, 0);
});

test('the signature covers the exact bytes: the same JSON re-spaced does not verify', async () => {
  const payload = fresh();
  const signature = devices.withingsSignature(JSON.stringify(payload), SECRET);
  assert.equal((await deliver(null, { raw: JSON.stringify(payload, null, 2), signature })).status, 403);
  assert.equal((await deliver(null, { raw: JSON.stringify(payload), signature })).status, 200);
});

test('an unsigned or wrongly signed delivery is rejected when the secret is set', async () => {
  const payload = fresh();
  assert.equal((await deliver(payload, { signature: null })).status, 403);
  assert.equal((await deliver(payload, { signature: '' })).status, 403);
  assert.equal((await deliver(payload, { signature: 'f'.repeat(64) })).status, 403);
  assert.equal((await deliver(payload, { signature: devices.withingsSignature(JSON.stringify(payload), 'not-the-secret') })).status, 403);
  assert.equal((await deliver(null, { raw: '', signature: null })).status, 403, 'an empty body is no exception');
  assert.equal((await deliver(null, { raw: '', signature: devices.withingsSignature('', SECRET) })).status, 400, 'correctly signed but empty: past the check, then not JSON');
  assert.equal(readings().length, 0);
});

test('a duplicate delivery stores one reading and raises one alert', async () => {
  const payload = { userid: USER, measuregrps: [group(70002, [{ value: 88, type: 54, unit: 0 }])] };
  const first = await deliver(payload);
  assert.equal(first.body.accepted.length, 1);
  for (let i = 0; i < 3; i++) {
    const again = await deliver(payload);
    assert.equal(again.status, 200);
    assert.deepEqual([again.body.accepted.length, again.body.duplicates], [0, 1]);
  }
  assert.equal(readings().length, 1);
  assert.equal(deviceAlerts().length, 1);
  assert.equal(store.listAudit(PID).filter((e) => e.type === 'device_reading').length, 1);
});

test('a delivery that repeats part of an earlier one only adds what is new', async () => {
  await deliver({ userid: USER, measuregrps: [group(70003, [{ value: 72, type: 11, unit: 0 }])] });
  const res = await deliver({ userid: USER, measuregrps: [group(70003, [{ value: 72, type: 11, unit: 0 }]), group(70004, [{ value: 75, type: 11, unit: 0 }])] });
  assert.deepEqual([res.body.accepted.length, res.body.duplicates], [1, 1]);
  assert.deepEqual(readings().map((r) => r.value), [72, 75]);
});

test('an out-of-range value is rejected, reported and audited; the rest of the delivery still counts', async () => {
  const res = await deliver({ userid: USER, measuregrps: [group(70005, [kg(20), { value: 70, type: 11, unit: 0 }]), group(70006, [{ value: 140, type: 54, unit: 0 }])] });
  assert.equal(res.status, 200, 'understood: retrying bad data would not fix it');
  assert.deepEqual(res.body.accepted.map((a) => a.type), ['hr']);
  assert.deepEqual(
    res.body.rejected.map((r) => [r.grpid, r.type]),
    [
      ['70005', 'weight'], // 20 kg = 44 lb, below the 50 lb floor
      ['70006', 'spo2'], // 140 %
    ],
  );
  assert.match(res.body.rejected[0].reason, /out of range/);
  assert.deepEqual(readings().map((r) => r.type), ['hr']);
  assert.ok(!store.getPatient(PID).weights.some((w) => w.lb < 50), 'the impossible weight never reached the weight history');
  assert.equal(deviceAlerts().length, 0);
  const trace = store.listAudit(PID).find((e) => e.type === 'device_rejected');
  assert.equal(trace.data.rejected.length, 2);
});

test('a reading dated in the future or more than 30 days ago is rejected', async () => {
  const now = Math.floor(clock.now() / 1000);
  const res = await deliver({
    userid: USER,
    measuregrps: [group(70007, [{ value: 70, type: 11, unit: 0 }], { date: now + 3600 }), group(70008, [{ value: 70, type: 11, unit: 0 }], { date: now - 40 * 86400 })],
  });
  assert.deepEqual(res.body.rejected.map((r) => r.reason), ['ts is in the future', 'ts is more than 30 days old']);
  assert.equal(readings().length, 0);
});

test('a measure the scale could not attribute is not counted as the patient\'s', async () => {
  const res = await deliver({ userid: USER, measuregrps: [group(70009, [kg(95)], { attrib: 1 })] });
  assert.equal(res.body.accepted.length, 0);
  assert.match(res.body.rejected[0].reason, /could not tell who/);
  assert.equal(readings().length, 0);
});

test('an unknown Withings user is a 404; a body that is not the expected JSON is a 400', async () => {
  assert.deepEqual(await deliver({ ...fresh(), userid: 999 }), { status: 404, body: { error: 'unknown Withings user' } });
  assert.equal((await deliver({ measuregrps: [] })).status, 404, 'no user id');
  assert.equal((await deliver(null, { raw: '{not json' })).status, 400);
  assert.equal((await deliver({ userid: USER })).status, 400);
  assert.equal((await deliver(null, { raw: '[]' })).status, 400);
  assert.equal(readings().length, 0);
});

test('the body is read as raw bytes whatever Content-Type the sender uses', async () => {
  assert.equal((await deliver(fresh(), { contentType: 'text/plain' })).status, 200);
  assert.equal(readings().length, 3);
});

test('production without WITHINGS_CLIENT_SECRET fails closed; dev without it accepts (nothing to verify against)', async () => {
  delete process.env.WITHINGS_CLIENT_SECRET;
  process.env.NODE_ENV = 'production';
  assert.deepEqual(await deliver(fresh(), { signature: null }), { status: 403, body: { error: 'webhook not configured' } });
  assert.equal((await deliver(fresh())).status, 403, 'even a well-formed signature: there is no secret to check it with');
  assert.equal(readings().length, 0);
  process.env.NODE_ENV = 'development';
  assert.equal((await deliver(fresh(), { signature: null })).status, 200);
  assert.equal(readings().length, 3);
});

test('production with the secret set works', async () => {
  process.env.NODE_ENV = 'production';
  assert.equal((await deliver(fresh())).status, 200);
  assert.equal((await deliver(fresh((g) => ({ ...g, grpid: g.grpid + 100 })), { signature: null })).status, 403);
});

// ---------- device links ----------
test('links: one Withings user maps to one patient, and a re-link moves it', () => {
  assert.equal(hooks.findDevicePatient('withings', USER).id, PID);
  assert.equal(hooks.findDevicePatient('withings', String(USER)).id, PID, 'number or string');
  assert.equal(hooks.findDevicePatient('withings', 424242), null);
  assert.equal(hooks.findDevicePatient('withings', null), null);
  assert.equal(hooks.findDevicePatient('other', USER), null);
  hooks.linkDevice('withings', USER, 'p4');
  assert.equal(hooks.findDevicePatient('withings', USER).id, 'p4');
  assert.equal(store.collection('device_links').length, 1, 're-linking does not add a second row');
  assert.equal(hooks.linkDevice('withings', 5, 'nobody'), null, 'an unknown patient cannot be linked');
  assert.ok(store.listAudit('p4').some((e) => e.type === 'device_link'));
});

test('the OAuth half is still a documented stub', () => {
  assert.equal(devices.withings.enabled(), false);
});
