// S6 + API robustness (audit 2026-10-11): with no API_TOKEN, a web page the nurse visits must not be
// able to write to (or read from) the API, and wrong-typed input must not become a 500 that leaks internals.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-csrf-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let server, base, port, store, security;
const EVIL = 'https://evil.example';
const form = (p, body, headers = {}) =>
  fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body });
const json = (method, p, body, headers = {}) =>
  fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
// fetch() cannot set Host; node:http can (that is what a rebinding attack looks like).
const withHost = (host, p = '/api/patients') =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { Host: host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });

before(async () => {
  store = await import('../src/store.js');
  security = await import('../src/security.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});
after(() => server?.close());
beforeEach(() => {
  delete process.env.API_TOKEN;
  delete process.env.CORS_ORIGIN;
  delete process.env.ALLOWED_HOSTS;
  process.env.NODE_ENV = 'test';
  security.resetRateLimits();
  store.reset();
});

test('a cross-site HTML form cannot create a patient, message one, advance the clock or wipe the DB', async () => {
  const before = store.listPatients().length;
  for (const [p, body] of [
    ['/api/patients', 'name=Evil&age=70'],
    ['/api/patients/p1/message', 'text=Stop+taking+your+meds&from=Nurse'],
    ['/api/patients/p1/simulate', 'text=chest+pain'],
    ['/api/patients/p1/unlink', 'role=patient'],
    ['/api/demo/advance', 'hours=720'],
    ['/api/reset', ''],
    ['/api/insights/cohort/regenerate', 'size=500'],
  ]) {
    const r = await form(p, body, { Origin: EVIL });
    assert.ok([403, 404].includes(r.status), `${p} -> ${r.status}`);
  }
  assert.equal(store.listPatients().length, before, 'nothing changed');
});

test('even a bodyless or JSON write from a foreign Origin is refused, and "null" origins too', async () => {
  assert.equal((await json('POST', '/api/reset', undefined, { Origin: EVIL })).status, 403);
  assert.equal((await json('POST', '/api/patients/p1/message', { text: 'x' }, { Origin: EVIL })).status, 403);
  assert.equal((await json('POST', '/api/reset', undefined, { Origin: 'null' })).status, 403);
  assert.equal((await json('POST', '/api/reset', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
});

test('urlencoded bodies are no longer parsed on JSON routes (only on /webhooks for Twilio)', async () => {
  const r = await form('/api/patients/p1/message', 'text=hello');
  assert.equal(r.status, 400, 'no usable body -> a clear 400, not a nurse message sent');
  const tw = await form('/webhooks/twilio/sms', new URLSearchParams({ From: '+14045550100', Body: 'hi' }));
  assert.notEqual(tw.status, 415);
});

test('same-machine pages and tools keep working: no Origin, localhost / LAN origins', async () => {
  assert.equal((await json('POST', '/api/patients/p1/message', { text: 'Weigh yourself tonight.' })).status, 200);
  assert.equal((await json('POST', '/api/patients/p1/message', { text: 'Weigh yourself tonight.' }, { Origin: 'http://localhost:5173' })).status, 200);
  assert.equal((await json('POST', '/api/patients/p1/message', { text: 'Weigh yourself tonight.' }, { Origin: 'http://192.168.1.20:5173' })).status, 200);
});

test('CORS in dev no longer reflects any origin (a foreign page cannot read patients)', async () => {
  const evil = await fetch(`${base}/api/patients`, { headers: { Origin: EVIL } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const local = await fetch(`${base}/api/patients`, { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const pre = await fetch(`${base}/api/alerts/x`, { method: 'OPTIONS', headers: { Origin: EVIL, 'Access-Control-Request-Method': 'PATCH' } });
  assert.equal(pre.headers.get('access-control-allow-origin'), null);
});

test('CORS_ORIGIN makes an explicit origin allowed for writes too', async () => {
  process.env.CORS_ORIGIN = 'https://dash.example.org';
  assert.equal((await json('POST', '/api/patients/p1/message', { text: 'Hi' }, { Origin: 'https://dash.example.org' })).status, 200);
  assert.equal((await json('POST', '/api/patients/p1/message', { text: 'Hi' }, { Origin: 'http://localhost:5173' })).status, 403);
});

test('DNS rebinding: an attacker Host header is refused in dev, ALLOWED_HOSTS lets a tunnel through', async () => {
  assert.equal(await withHost('evil.example'), 421);
  assert.equal(await withHost(`localhost:${port}`), 200);
  assert.equal(await withHost(`192.168.0.5:${port}`), 200);
  process.env.ALLOWED_HOSTS = 'demo.ngrok.app';
  assert.equal(await withHost('demo.ngrok.app'), 200);
});

test('with API_TOKEN set the Origin / Host guards step aside (the token is the protection)', async () => {
  process.env.API_TOKEN = 's3cret';
  assert.equal(await withHost('evil.example'), 401, 'reaches auth: refused for the missing token, not the Host');
  const ok = await json('POST', '/api/patients/p1/message', { text: 'Hi' }, { Origin: EVIL, Authorization: 'Bearer s3cret' });
  assert.equal(ok.status, 200);
});

test('wrong-typed text is a 400, never a 500 that leaks "text?.trim is not a function"', async () => {
  for (const bad of [true, 5, {}, []]) {
    const m = await json('POST', '/api/patients/p1/message', { text: bad });
    assert.equal(m.status, 400, `message text ${JSON.stringify(bad)} -> ${m.status}`);
    const s = await json('POST', '/api/patients/p1/simulate', { text: bad });
    assert.equal(s.status, 400, `simulate text ${JSON.stringify(bad)} -> ${s.status}`);
    assert.ok(!/not a function/.test(await s.text()));
  }
  assert.equal((await json('POST', '/api/patients/p1/message', { text: 'ok', from: 7 })).status, 400);
  assert.equal((await json('POST', '/api/patients/p1/simulate', { buttonData: {} })).status, 400);
  assert.equal((await json('POST', '/api/patients/p1/simulate', { text: 'hi', photo: 'x' })).status, 400);
});

test('a 100 KB message is cut to a sane size before anything reads it', async () => {
  const agent = await import('../src/core/agent.js');
  await agent.handleInbound({ patientId: 'p1', text: 'a'.repeat(100_000), channel: 'sim' });
  const last = store.listMessages('p1').filter((m) => m.direction === 'in').at(-1);
  assert.ok(last.text.length <= 4000);
});
