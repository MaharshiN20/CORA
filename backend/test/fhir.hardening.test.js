// Phase 4: FHIR import is atomic (a double click cannot create two patients), finds earlier imports
// without scanning the audit log, and never leaks internals in errors.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-fhir-hard-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
process.env.FHIR_BASE_URL = 'http://fhir.test/baseR4';
delete process.env.TELEGRAM_BOT_TOKEN;

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'fhir', `${name}.json`), 'utf8'));

let store, server, base;
const realFetch = globalThis.fetch;
const FHIR = 'http://fhir.test/baseR4/';
let delayMs = 0;
let broken = null;
before(async () => {
  store = await import('../src/store.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  globalThis.fetch = realFetch;
  server?.close();
});
beforeEach(() => {
  store.reset();
  delayMs = 0;
  broken = null;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (!u.startsWith(FHIR)) return realFetch(url, opts);
    if (broken) throw broken;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const p = u.slice(FHIR.length);
    if (p === 'Patient/hb-rosa-1') return Response.json(fx('patient-rosa'));
    if (p.startsWith('MedicationRequest')) return Response.json(fx('meds-rosa'));
    if (p.startsWith('Condition')) return Response.json(fx('conditions-rosa'));
    if (p.startsWith('Observation')) return Response.json(fx('weights-rosa'));
    return Response.json(fx('empty-bundle'));
  };
});

const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const imports = () => store.listPatients().filter((p) => p.source === 'fhir');

test('a double click on Import creates one patient: the second request is refused while the first is running', async () => {
  delayMs = 40;
  const [a, b] = await Promise.all([post('/api/fhir/import', { fhirPatientId: 'hb-rosa-1' }), post('/api/fhir/import', { fhirPatientId: 'hb-rosa-1' })]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal(imports().length, 1);
  const loser = a.status === 409 ? a : b;
  assert.ok(loser.body.error);
});

test('after an import, a later one is refused using the patient record (no audit scan needed)', async () => {
  const first = await post('/api/fhir/import', { fhirPatientId: 'hb-rosa-1' });
  assert.equal(first.status, 201);
  const p = store.getPatient(first.body.patient.id);
  assert.equal(p.fhirId, 'hb-rosa-1');
  assert.equal(p.fhirBase, 'http://fhir.test/baseR4');
  store.collection('audit').length = 0; // even with the audit log gone
  const again = await post('/api/fhir/import', { fhirPatientId: 'hb-rosa-1' });
  assert.equal(again.status, 409);
  assert.equal(again.body.patientId, p.id);
});

test('imports made before this change (audit row only) are still recognised', async () => {
  const first = await post('/api/fhir/import', { fhirPatientId: 'hb-rosa-1' });
  const id = first.body.patient.id;
  store.updatePatient(id, { fhirId: undefined, fhirBase: undefined });
  const again = await post('/api/fhir/import', { fhirPatientId: 'hb-rosa-1' });
  assert.equal(again.status, 409);
});

test('a failed import releases the claim so the nurse can retry', async () => {
  broken = new TypeError('fetch failed');
  const err = console.error;
  console.error = () => {};
  let down;
  try {
    down = await post('/api/fhir/import', { fhirPatientId: 'hb-rosa-1' });
  } finally {
    console.error = err;
  }
  assert.equal(down.status, 502);
  broken = null;
  assert.equal((await post('/api/fhir/import', { fhirPatientId: 'hb-rosa-1' })).status, 201);
});

test('an unexpected server error returns a generic message, never the internal one', async () => {
  const bad = new Error('secret internal detail: /var/db/passwords');
  broken = bad;
  const err = console.error;
  console.error = () => {};
  let res;
  try {
    res = await fetch(`${base}/api/fhir/preview/hb-rosa-1`);
  } finally {
    console.error = err;
  }
  const body = await res.json();
  assert.ok(res.status >= 500);
  assert.ok(!JSON.stringify(body).includes('secret internal detail'), JSON.stringify(body));
});
