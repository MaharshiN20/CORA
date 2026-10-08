// K16: production must never send a patient's name to the public HAPI test server.
// Every FHIR request is mocked; the mock also counts what would have left the building.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-fhir-sandbox-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.FHIR_BASE_URL;

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'fhir', `${name}.json`), 'utf8'));

const SANDBOX = 'https://hapi.fhir.org/baseR4';
const OWN = 'https://fhir.hospital.example.org/r4';
const ENV_KEYS = ['FHIR_BASE_URL', 'NODE_ENV', 'DEMO_MODE'];

let store, fhir, readiness, security, server, base;
const realFetch = globalThis.fetch;
let outbound; // every request that went to a FHIR server

before(async () => {
  store = await import('../src/store.js');
  fhir = await import('../src/integrations/fhir.js');
  readiness = await import('../src/readiness.js');
  security = await import('../src/security.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  globalThis.fetch = realFetch;
  server?.close();
});
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  store.reset();
  security.resetRateLimits();
  outbound = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith(base)) return realFetch(url, opts);
    outbound.push(u);
    const p = u.replace(/^https?:\/\/[^/]+\/[^/]+\//, '');
    if (p.startsWith('Patient?')) return Response.json(fx('search-delgado'));
    if (p === 'Patient/hb-rosa-1') return Response.json(fx('patient-rosa'));
    if (p.startsWith('MedicationRequest')) return Response.json(fx('meds-rosa'));
    if (p.startsWith('Condition')) return Response.json(fx('conditions-rosa'));
    if (p.startsWith('Observation')) return Response.json(fx('weights-rosa'));
    return Response.json(fx('empty-bundle'));
  };
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

const get = async (p) => {
  const r = await realFetch(base + p);
  return { status: r.status, body: await r.json() };
};
const post = async (p, body) => {
  const r = await realFetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const imported = () => store.listPatients().filter((p) => p.source === 'fhir');

// ---------- fhirTarget (pure) ----------
test('fhirTarget: where requests go, whether that is the sandbox, and whether it is allowed', () => {
  assert.deepEqual(fhir.fhirTarget({}), { base: SANDBOX, sandbox: true, allowed: true });
  assert.deepEqual(fhir.fhirTarget({ NODE_ENV: 'development' }), { base: SANDBOX, sandbox: true, allowed: true });
  assert.deepEqual(fhir.fhirTarget({ NODE_ENV: 'production', FHIR_BASE_URL: `${OWN}/` }), { base: OWN, sandbox: false, allowed: true });
  const refused = fhir.fhirTarget({ NODE_ENV: 'production' });
  assert.deepEqual([refused.base, refused.sandbox, refused.allowed], [SANDBOX, true, false]);
  assert.match(refused.reason, /public HAPI test server/);
  assert.match(refused.reason, /FHIR_BASE_URL/);
  // Writing the sandbox into FHIR_BASE_URL (what .env.example ships) is no way around it.
  assert.equal(fhir.fhirTarget({ NODE_ENV: 'production', FHIR_BASE_URL: SANDBOX }).allowed, false);
  assert.equal(fhir.fhirTarget({ NODE_ENV: 'production', FHIR_BASE_URL: 'https://hapi.fhir.org/baseR5' }).allowed, false);
  // A production-mode demo with made-up patients says so explicitly.
  assert.deepEqual(fhir.fhirTarget({ NODE_ENV: 'production', DEMO_MODE: '1' }), { base: SANDBOX, sandbox: true, allowed: true });
  assert.equal(fhir.fhirTarget({ NODE_ENV: 'production', DEMO_MODE: '0' }).allowed, false);
});

// ---------- development ----------
test('development, FHIR_BASE_URL unset: everything works and is flagged as the sandbox', async () => {
  const info = await get('/api/fhir');
  assert.deepEqual(info.body, { ok: true, base: SANDBOX, sandbox: true, available: true });
  const search = await get('/api/fhir/search?name=delgado');
  assert.equal(search.status, 200);
  assert.ok(search.body.length >= 1);
  assert.equal((await get('/api/fhir/preview/hb-rosa-1')).status, 200);
  const done = await post('/api/fhir/import', { fhirPatientId: 'hb-rosa-1' });
  assert.equal(done.status, 201);
  assert.equal(imported().length, 1);
  assert.ok(outbound.every((u) => u.startsWith(SANDBOX)), 'requests went to the sandbox, as flagged');
});

// ---------- production, unset ----------
test('production, FHIR_BASE_URL unset: search, preview and import are refused with 503 and nothing is sent', async () => {
  process.env.NODE_ENV = 'production';
  const info = await get('/api/fhir');
  assert.equal(info.status, 200, 'the info endpoint still answers, so the dashboard can say why');
  assert.equal(info.body.sandbox, true);
  assert.equal(info.body.available, false);
  assert.match(info.body.error, /EHR import is off/);

  const search = await get('/api/fhir/search?name=delgado');
  assert.equal(search.status, 503);
  assert.deepEqual(Object.keys(search.body), ['error']);
  assert.match(search.body.error, /Set FHIR_BASE_URL to your own FHIR server/);

  assert.equal((await get('/api/fhir/preview/hb-rosa-1')).status, 503);
  const refused = await post('/api/fhir/import', { fhirPatientId: 'hb-rosa-1' });
  assert.equal(refused.status, 503);
  assert.match(refused.body.error, /EHR import is off/);
  assert.equal((await post('/api/fhir/import', { fhirPatientId: 'hb-rosa-1', override: true })).status, 503, 'override is for the clinical checks, not for this');

  assert.deepEqual(outbound, [], 'not one request left for the public server');
  assert.equal(imported().length, 0);
});

test('production with the sandbox written into FHIR_BASE_URL is refused the same way', async () => {
  process.env.NODE_ENV = 'production';
  process.env.FHIR_BASE_URL = SANDBOX;
  assert.equal((await get('/api/fhir/search?name=delgado')).status, 503);
  assert.equal((await post('/api/fhir/import', { fhirPatientId: 'hb-rosa-1' })).status, 503);
  assert.deepEqual(outbound, []);
});

test('a refused import can be retried once the server is configured (no stuck "already importing")', async () => {
  process.env.NODE_ENV = 'production';
  assert.equal((await post('/api/fhir/import', { fhirPatientId: 'hb-rosa-1' })).status, 503);
  process.env.FHIR_BASE_URL = OWN;
  assert.equal((await post('/api/fhir/import', { fhirPatientId: 'hb-rosa-1' })).status, 201);
});

// ---------- production, set ----------
test('production with its own FHIR server: works, not flagged, and only that server is called', async () => {
  process.env.NODE_ENV = 'production';
  process.env.FHIR_BASE_URL = OWN;
  assert.deepEqual((await get('/api/fhir')).body, { ok: true, base: OWN, sandbox: false, available: true });
  const search = await get('/api/fhir/search?name=delgado');
  assert.equal(search.status, 200);
  assert.ok(search.body.length >= 1);
  const done = await post('/api/fhir/import', { fhirPatientId: 'hb-rosa-1' });
  assert.equal(done.status, 201);
  assert.equal(done.body.patient.fhirBase, OWN);
  assert.ok(outbound.length > 0 && outbound.every((u) => u.startsWith(OWN)), outbound.join('\n'));
});

// ---------- the demo exception ----------
test('production with DEMO_MODE=1 (made-up patients by declaration): the sandbox works and is flagged', async () => {
  process.env.NODE_ENV = 'production';
  process.env.DEMO_MODE = '1';
  assert.deepEqual((await get('/api/fhir')).body, { ok: true, base: SANDBOX, sandbox: true, available: true });
  assert.equal((await get('/api/fhir/search?name=delgado')).status, 200);
  assert.equal((await post('/api/fhir/import', { fhirPatientId: 'hb-rosa-1' })).status, 201);
});

// ---------- what is not affected ----------
test('the local export preview still works when import is refused: it sends nothing anywhere', async () => {
  process.env.NODE_ENV = 'production';
  const bundle = await get('/api/fhir/export/p1');
  assert.equal(bundle.status, 200);
  assert.equal(bundle.body.resourceType, 'Bundle');
  assert.deepEqual(outbound, []);
});

test('input validation still answers before the guard, and other errors keep their codes', async () => {
  process.env.NODE_ENV = 'production';
  assert.equal((await get('/api/fhir/search?name=d')).status, 400);
  assert.equal((await post('/api/fhir/import', {})).status, 400);
  process.env.FHIR_BASE_URL = OWN;
  globalThis.fetch = async (url, opts) => (String(url).startsWith(base) ? realFetch(url, opts) : Promise.reject(new Error('ECONNREFUSED')));
  const down = await get('/api/fhir/search?name=delgado');
  assert.equal(down.status, 502, 'an unreachable EHR is still a 502, not the sandbox 503');
});

// ---------- the startup warning tells the same story ----------
test('the startup config warning matches: refused in production, allowed-with-a-caveat in a demo', () => {
  const warn = (env) => readiness.configWarnings({ API_TOKEN: 'x', CORS_ORIGIN: 'https://d.example', NURSE_CHAT_ID: '1', TELEGRAM_BOT_TOKEN: '1:a', ...env }).find((w) => w.code === 'fhir_public_sandbox')?.message;
  assert.match(warn({ NODE_ENV: 'production' }), /refused \(503\)/);
  assert.match(warn({ NODE_ENV: 'production', DEMO_MODE: '1' }), /DEMO_MODE=1 allows it.*Made-up patients only/);
  assert.equal(warn({ NODE_ENV: 'production', FHIR_BASE_URL: OWN }), undefined);
  assert.equal(warn({ NODE_ENV: 'development' }), undefined);
});
