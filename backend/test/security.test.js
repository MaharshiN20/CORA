// Phase 1: API token, demo gating, CORS, rate limits, JSON errors, body limits.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-security-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let server, base, security;
const realFetch = globalThis.fetch;
const get = (p, headers) => realFetch(`${base}${p}`, { headers });
const post = (p, body, headers = {}) =>
  realFetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });

before(async () => {
  security = await import('../src/security.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());
beforeEach(() => {
  delete process.env.API_TOKEN;
  delete process.env.DEMO_MODE;
  delete process.env.CORS_ORIGIN;
  process.env.NODE_ENV = 'test';
  security.resetRateLimits();
});

test('no API_TOKEN set: the API is open (no key needed to run or test)', async () => {
  assert.equal((await get('/api/patients')).status, 200);
});

test('API_TOKEN set: /api needs the token (Bearer or x-api-token); health and join stay public', async () => {
  process.env.API_TOKEN = 's3cret';
  assert.equal((await get('/api/patients')).status, 401);
  assert.equal((await get('/api/patients', { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await get('/api/patients', { Authorization: 'Bearer s3cret' })).status, 200);
  assert.equal((await get('/api/patients', { 'x-api-token': 's3cret' })).status, 200);
  assert.equal((await get('/api/health')).status, 200);
  assert.equal((await get('/api/join')).status, 200);
});

test('socket handshake uses the same token', () => {
  process.env.API_TOKEN = 's3cret';
  const run = (token) => {
    let err;
    security.socketAuth({ handshake: { auth: { token } } }, (e) => (err = e));
    return err;
  };
  assert.ok(run('nope') instanceof Error);
  assert.ok(run(undefined) instanceof Error);
  assert.equal(run('s3cret'), undefined);
  delete process.env.API_TOKEN;
  assert.equal(run(undefined), undefined);
});

test('demo and reset routes are on in dev, off in production unless DEMO_MODE=1', async () => {
  assert.equal((await get('/api/demo/clock')).status, 200);
  process.env.NODE_ENV = 'production';
  assert.equal((await get('/api/demo/clock')).status, 404);
  assert.equal((await post('/api/reset')).status, 404);
  assert.equal((await post('/api/insights/cohort/regenerate')).status, 404);
  assert.equal((await get('/api/patients')).status, 200, 'real routes unaffected');
  process.env.DEMO_MODE = '1';
  assert.equal((await get('/api/demo/clock')).status, 200);
  process.env.DEMO_MODE = '0';
  process.env.NODE_ENV = 'development';
  assert.equal((await get('/api/demo/clock')).status, 404);
});

test('CORS: allowed origin list when CORS_ORIGIN is set, none in production when unset', async () => {
  process.env.CORS_ORIGIN = 'https://dash.example.org';
  const ok = await get('/api/health', { Origin: 'https://dash.example.org' });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://dash.example.org');
  const bad = await get('/api/health', { Origin: 'https://evil.example.com' });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  delete process.env.CORS_ORIGIN;
  process.env.NODE_ENV = 'production';
  const prod = await get('/api/health', { Origin: 'https://evil.example.com' });
  assert.equal(prod.headers.get('access-control-allow-origin'), null);
});

test('security headers are set', async () => {
  const res = await get('/api/health');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('errors are JSON with no stack; unknown /api paths are a JSON 404', async () => {
  const bad = await realFetch(`${base}/api/patients`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
  assert.equal(bad.status, 400);
  const body = await bad.json();
  assert.ok(body.error);
  assert.ok(!/at .*node_modules|\.js:\d+/.test(JSON.stringify(body)), 'no stack trace');
  const nf = await get('/api/nope');
  assert.equal(nf.status, 404);
  assert.ok((await nf.json()).error);
});

test('JSON bodies over 100 KB are rejected except on the photo route', async () => {
  const big = 'x'.repeat(200 * 1024);
  const res = await post('/api/patients', { name: big });
  assert.equal(res.status, 413);
  const photo = await post('/api/patients/p1/simulate', { photo: { base64: big, mime: 'image/jpeg' } });
  assert.notEqual(photo.status, 413, 'simulate accepts photo-sized bodies');
});

test('rate limit: a burst on /api/devices/readings gets 429', async () => {
  let last;
  for (let i = 0; i < 130; i++) last = await post('/api/devices/readings', { patientId: 'nope', type: 'weight', value: 150 });
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'));
});

test('ROI query: only known numeric params get through', async () => {
  const res = await get('/api/insights/roi?discharges=1000&bogus=1&reduction[x]=1&costPerReadmit=abc');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.bogus, undefined);
});
