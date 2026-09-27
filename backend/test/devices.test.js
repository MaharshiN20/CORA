// K6: virtual devices. Argument parsing and request payloads with a mocked fetch, plus one run
// against the real express app on a random port (local only, no outside network).
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-devices-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let devices, scale, oximeter, store, server, base;

before(async () => {
  devices = await import('../src/integrations/devices.js');
  scale = await import('../tools/virtual-scale.js');
  oximeter = await import('../tools/virtual-oximeter.js');
  store = await import('../src/store.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());
beforeEach(() => store.reset());

// Records every request; answers like the backend would.
function fakeApi({ patient = { weights: [{ ts: '2026-09-20T12:00:00Z', lb: 176.8 }], readings: [] }, fail = [] } = {}) {
  const requests = [];
  let now = Date.parse('2026-09-26T12:00:00Z');
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url: String(url), method: init.method ?? 'GET', body });
    const planned = fail.shift();
    if (planned === 'network') throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    if (typeof planned === 'number') return Response.json({ error: 'nope' }, { status: planned });
    if (String(url).endsWith('/api/demo/advance')) {
      now += body.hours * 3600_000;
      return Response.json({ now: new Date(now).toISOString(), offsetMs: 0, jobs: {} });
    }
    if (String(url).includes('/api/patients/')) return Response.json(patient);
    return Response.json({ id: 'r1', ...body }, { status: 201 });
  };
  return { requests, fetchImpl };
}

const quietLog = () => {};
const posts = (requests) => requests.filter((r) => r.method === 'POST');

// ---------- helpers ----------
test('parseArgs handles values, --key=value, flags and negative numbers', () => {
  assert.deepEqual(devices.parseArgs(['--patient', 'p1', '--lb=177.4', '--trend', '-1/day', '--help']), {
    patient: 'p1',
    lb: '177.4',
    trend: '-1/day',
    help: true,
  });
  assert.throws(() => devices.parseArgs(['p1']), /unexpected argument/);
});

test('parseTrend accepts +0.8/day, -1/d and bare numbers, rejects junk', () => {
  assert.equal(devices.parseTrend('+0.8/day'), 0.8);
  assert.equal(devices.parseTrend('-1/d'), -1);
  assert.equal(devices.parseTrend('0.5'), 0.5);
  assert.throws(() => devices.parseTrend('fast'), /\+0\.8\/day/);
});

test('planSeries builds a rounded day-by-day series and bounds days', () => {
  assert.deepEqual(devices.planSeries({ first: 177.6, perDay: 0.8, days: 5 }), [177.6, 178.4, 179.2, 180, 180.8]);
  assert.throws(() => devices.planSeries({ first: 1, days: 0 }), /days/);
  assert.throws(() => devices.planSeries({ first: 1, days: 2.5 }), /days/);
});

test('validateReading mirrors the API ranges', () => {
  assert.doesNotThrow(() => devices.validateReading({ patientId: 'p1', type: 'weight', value: 177.4 }));
  assert.throws(() => devices.validateReading({ patientId: 'p1', type: 'weight', value: 20 }), /outside 50-700/);
  assert.throws(() => devices.validateReading({ patientId: 'p1', type: 'spo2', value: 101 }), /outside/);
  assert.throws(() => devices.validateReading({ patientId: 'p1', type: 'bp', value: 120 }), /type must be/);
  assert.throws(() => devices.validateReading({ type: 'weight', value: 170 }), /--patient/);
});

test('postJSON retries network errors and 5xx, but not 4xx', async () => {
  const flaky = fakeApi({ fail: ['network', 503] });
  const out = await devices.postJSON('http://x/api/devices/readings', { a: 1 }, { fetchImpl: flaky.fetchImpl, retryDelayMs: 0 });
  assert.equal(out.a, 1);
  assert.equal(flaky.requests.length, 3);

  const bad = fakeApi({ fail: [400] });
  await assert.rejects(() => devices.postJSON('http://x/y', {}, { fetchImpl: bad.fetchImpl, retryDelayMs: 0 }), /HTTP 400: nope/);
  assert.equal(bad.requests.length, 1);

  const down = fakeApi({ fail: ['network', 'network', 'network'] });
  await assert.rejects(() => devices.postJSON('http://x/y', {}, { fetchImpl: down.fetchImpl, retryDelayMs: 0 }), /ECONNREFUSED.*backend running/);
});

test('the Withings stub is documented and disabled', () => {
  assert.equal(devices.withings.enabled(), false);
  assert.throws(() => devices.withings.authorizeUrl(), /not implemented/);
});

// ---------- virtual scale ----------
test('scale --lb posts one weight reading with the device name', async () => {
  const api = fakeApi();
  await scale.main(['--patient', 'p1', '--lb', '177.4', '--api', 'http://hb:3001/'], { fetchImpl: api.fetchImpl, log: quietLog });
  assert.deepEqual(api.requests, [
    { url: 'http://hb:3001/api/devices/readings', method: 'POST', body: { patientId: 'p1', type: 'weight', value: 177.4, device: 'virtual-scale' } },
  ]);
});

test('scale --trend continues from the last weight and advances the clock between days', async () => {
  const api = fakeApi();
  await scale.main(['--patient', 'p1', '--trend', '+0.8/day', '--days', '3', '--api', 'http://hb'], { fetchImpl: api.fetchImpl, log: quietLog });
  assert.equal(api.requests[0].url, 'http://hb/api/patients/p1');
  const seq = posts(api.requests).map((r) => (r.url.endsWith('/advance') ? `advance ${r.body.hours}h` : `weight ${r.body.value}`));
  assert.deepEqual(seq, ['weight 177.6', 'advance 24h', 'weight 178.4', 'advance 24h', 'weight 179.2']);
});

test('scale --trend with --lb starts exactly there and never asks for the patient', async () => {
  const api = fakeApi();
  await scale.main(['--patient', 'p1', '--lb', '176', '--trend', '-0.5/day', '--days', '2', '--api', 'http://hb'], { fetchImpl: api.fetchImpl, log: quietLog });
  assert.ok(!api.requests.some((r) => r.url.includes('/api/patients/')));
  assert.deepEqual(posts(api.requests).filter((r) => r.body.type).map((r) => r.body.value), [176, 175.5]);
});

test('scale prefers the newest of device and check-in weights as the starting point', async () => {
  const api = fakeApi({
    patient: {
      weights: [{ ts: '2026-09-20T12:00:00Z', lb: 176.8 }],
      readings: [{ ts: '2026-09-21T12:00:00Z', type: 'weight', value: 178 }],
    },
  });
  await scale.main(['--patient', 'p1', '--trend', '+1/day', '--days', '1', '--api', 'http://hb'], { fetchImpl: api.fetchImpl, log: quietLog });
  assert.equal(posts(api.requests)[0].body.value, 179);
});

test('scale argument errors are clear and send nothing', async () => {
  const api = fakeApi();
  const run = (argv) => scale.main(argv, { fetchImpl: api.fetchImpl, log: quietLog });
  await assert.rejects(() => run(['--lb', '170']), /--patient is required/);
  await assert.rejects(() => run(['--patient', 'p1']), /pass --lb or --trend/);
  await assert.rejects(() => run(['--patient', 'p1', '--lb', 'heavy']), /--lb needs a number/);
  await assert.rejects(() => run(['--patient', 'p1', '--lb', '900']), /outside 50-700/);
  await assert.rejects(() => run(['--patient', 'p1', '--trend', '+1/day', '--days', '99', '--lb', '170']), /--days/);
  assert.equal(api.requests.length, 0);
});

test('scale --trend with no weight history asks for --lb', async () => {
  const api = fakeApi({ patient: { weights: [], readings: [] } });
  await assert.rejects(() => scale.main(['--patient', 'p9', '--trend', '+1/day'], { fetchImpl: api.fetchImpl, log: quietLog }), /pass --lb/);
});

test('--help prints usage and sends nothing', async () => {
  const lines = [];
  const api = fakeApi();
  await scale.main(['--help'], { fetchImpl: api.fetchImpl, log: (l) => lines.push(l) });
  await oximeter.main(['--help'], { fetchImpl: api.fetchImpl, log: (l) => lines.push(l) });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /virtual-scale/);
  assert.match(lines[1], /virtual-oximeter/);
  assert.equal(api.requests.length, 0);
});

// ---------- virtual oximeter ----------
test('oximeter posts SpO2 and heart rate together', async () => {
  const api = fakeApi();
  await oximeter.main(['--patient', 'p1', '--spo2', '94', '--hr', '82', '--api', 'http://hb'], { fetchImpl: api.fetchImpl, log: quietLog });
  assert.deepEqual(
    posts(api.requests).map((r) => r.body),
    [
      { patientId: 'p1', type: 'spo2', value: 94, device: 'virtual-oximeter' },
      { patientId: 'p1', type: 'hr', value: 82, device: 'virtual-oximeter' },
    ],
  );
});

test('oximeter trends round to whole percents, cap at 100, and advance the clock', async () => {
  const api = fakeApi();
  await oximeter.main(['--patient', 'p1', '--spo2', '99.6', '--trend', '-1.5/day', '--days', '3', '--api', 'http://hb'], { fetchImpl: api.fetchImpl, log: quietLog });
  const seq = posts(api.requests).map((r) => (r.url.endsWith('/advance') ? 'advance' : r.body.value));
  assert.deepEqual(seq, [100, 'advance', 98, 'advance', 97]);
});

test('oximeter requires --spo2 and validates ranges before sending', async () => {
  const api = fakeApi();
  const run = (argv) => oximeter.main(argv, { fetchImpl: api.fetchImpl, log: quietLog });
  await assert.rejects(() => run(['--patient', 'p1']), /--spo2 is required/);
  await assert.rejects(() => run(['--patient', 'p1', '--spo2', '40']), /outside 50-100/);
  await assert.rejects(() => run(['--patient', 'p1', '--spo2', '95', '--hr', '400']), /outside 20-250/);
  assert.equal(api.requests.length, 0);
});

// ---------- against the real app ----------
test('a scale trend lands in GET /api/patients/p1 readings, one demo day apart', async () => {
  await scale.main(['--patient', 'p1', '--lb', '177.4', '--trend', '+0.8/day', '--days', '3', '--api', base], { log: quietLog });
  const p = await (await fetch(`${base}/api/patients/p1`)).json();
  const weights = p.readings.filter((r) => r.type === 'weight' && r.source === 'device');
  assert.deepEqual(weights.map((r) => r.value), [177.4, 178.2, 179]);
  assert.ok(weights.every((r) => r.device === 'virtual-scale'));
  const gap = Date.parse(weights[1].ts) - Date.parse(weights[0].ts);
  assert.ok(gap >= 24 * 3600_000 && gap < 25 * 3600_000, `readings ${gap / 3600_000}h apart`);
});

test('an unknown patient fails fast with the server message', async () => {
  await assert.rejects(() => scale.main(['--patient', 'nobody', '--lb', '170', '--api', base], { log: quietLog }), /HTTP 404: unknown patientId/);
});
