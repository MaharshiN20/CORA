// M5 FHIR import: mapping against recorded fixtures + the HTTP routes with a fake FHIR server.
// No network: every FHIR request is answered from backend/test/fixtures/fhir.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-fhir-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
process.env.FHIR_BASE_URL = 'http://fhir.test/baseR4';
delete process.env.TELEGRAM_BOT_TOKEN;

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'fhir', `${name}.json`), 'utf8'));
const entries = (b) => (b.entry ?? []).map((e) => e.resource);

let store, fhir, enroll, server, base;
before(async () => {
  store = await import('../src/store.js');
  fhir = await import('../src/integrations/fhir.js');
  enroll = await import('../src/core/enroll.js');
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
  globalThis.fetch = fakeFhir(ROUTES);
});

// ---- fake FHIR server -------------------------------------------------------
const realFetch = globalThis.fetch;
const FHIR = 'http://fhir.test/baseR4/';
const ROUTES = {
  'Patient?name=delgado': () => fx('search-delgado'),
  'Patient/hb-rosa-1': () => fx('patient-rosa'),
  'Patient/hb-ahmed-2': () => fx('patient-nobirth'),
  'Patient/hb-noname-4': () => ({ resourceType: 'Patient', id: 'hb-noname-4', birthDate: '1950-01-01' }),
  'MedicationRequest?subject=Patient%2Fhb-rosa-1': () => fx('meds-rosa'),
  'Condition?subject=Patient%2Fhb-rosa-1': () => fx('conditions-rosa'),
  'Observation?subject=Patient%2Fhb-rosa-1': () => fx('weights-rosa'),
};
let fhirCalls = [];

function fakeFhir(routes) {
  fhirCalls = [];
  return async (url, opts) => {
    const u = String(url);
    if (!u.startsWith(FHIR)) return realFetch(url, opts); // our own API under test
    const pathQ = u.slice(FHIR.length);
    fhirCalls.push(pathQ);
    const key = Object.keys(routes).find((k) => pathQ === k || pathQ.startsWith(`${k}&`));
    if (!key) {
      // Unknown patient -> 404; unknown search for a known patient -> empty bundle.
      if (/^Patient\/[^?]+$/.test(pathQ)) return new Response('{"resourceType":"OperationOutcome"}', { status: 404 });
      return Response.json(fx('empty-bundle'));
    }
    const body = routes[key]();
    return body instanceof Response ? body : Response.json(body);
  };
}

const NOW = Date.parse('2026-09-27T12:00:00Z');
const SUPPORTED = ['en', 'es', 'vi', 'zh', 'hi', 'ko', 'ht', 'ar', 'pt', 'tl'];

// ---- pure mapping -----------------------------------------------------------

test('patient: official name, age from birthDate, preferred language', () => {
  const p = fx('patient-rosa');
  assert.equal(fhir.mapName(p), 'Rosa María Delgado');
  assert.equal(fhir.ageFrom('1948-03-12', NOW), 78);
  assert.equal(fhir.ageFrom('1948-12-30', NOW), 77); // birthday not reached yet this year
  assert.equal(fhir.ageFrom('1961', NOW), 65); // year-only birthDate
  assert.deepEqual(fhir.mapLanguage(p, SUPPORTED), { language: 'es', raw: 'es-MX', mapped: true });
});

test('edge cases: missing birthDate, unsupported language, text-only name and language', () => {
  const p = fx('patient-nobirth');
  assert.equal(fhir.mapName(p), 'Ahmed Warsame');
  assert.equal(fhir.ageFrom(p.birthDate, NOW), null);
  assert.equal(fhir.ageFrom('not-a-date', NOW), null);
  assert.deepEqual(fhir.mapLanguage(p, SUPPORTED), { language: 'en', raw: 'so', mapped: false });
  assert.deepEqual(fhir.mapLanguage({ communication: [{ language: { text: 'Vietnamese' } }] }, SUPPORTED), { language: 'vi', raw: 'Vietnamese', mapped: true });
  assert.deepEqual(fhir.mapLanguage({}, SUPPORTED), { language: 'en', raw: null, mapped: false });
  assert.equal(fhir.mapName({ name: [] }), null);
});

test('medications: active only, deduped, dose + reminder times, diuretic flagged, prescriptions to pick up', () => {
  const { meds, prescriptions } = fhir.mapMedications(entries(fx('meds-rosa')), NOW);
  assert.deepEqual(meds, [
    { name: 'Furosemide', dose: '40 mg', times: ['08:00', '20:00'], diuretic: true },
    { name: 'Carvedilol', dose: '12.5 mg', times: ['08:00', '20:00'] },
    { name: 'Lisinopril', dose: '5 mg', times: ['08:00'] }, // the stopped 10 mg order is skipped
  ]);
  assert.deepEqual(prescriptions, [
    { med: 'Furosemide', expectedPickup: '2026-09-21T00:00:00.000Z', pickedUpAt: null }, // dispense validity start
    { med: 'Carvedilol', expectedPickup: '2026-09-20T15:00:00.000Z', pickedUpAt: null }, // authoredOn
    { med: 'Lisinopril', expectedPickup: '2026-09-20T15:00:00.000Z', pickedUpAt: null },
  ]);
  assert.deepEqual(fhir.mapMedications([], NOW), { meds: [], prescriptions: [] });
  assert.deepEqual(fhir.splitMedText('Furosemide 40 MG Oral Tablet'), { name: 'Furosemide', dose: '40 mg' });
  assert.deepEqual(fhir.splitMedText('spironolactone'), { name: 'Spironolactone', dose: null });
});

test('conditions: SNOMED, ICD-10 and free text; resolved ones ignored', () => {
  const { flags, matched } = fhir.mapConditions(entries(fx('conditions-rosa')));
  assert.deepEqual(flags, { ckd: true, diabetes: true, copd: false, heartFailure: true });
  assert.deepEqual(matched.map((m) => m.flag), ['heartFailure', 'ckd', 'diabetes']);
  assert.deepEqual(fhir.mapConditions([]).flags, { ckd: false, diabetes: false, copd: false, heartFailure: false });
});

test('weights: kg and lb to lb, sorted, errors dropped', () => {
  assert.deepEqual(fhir.mapWeights(entries(fx('weights-rosa'))), [
    { ts: '2026-09-18T08:00:00.000Z', lb: 176 },
    { ts: '2026-09-20T08:00:00.000Z', lb: 173.1 }, // 78.5 kg
  ]);
});

test('toPatientData: every profile field explicit, warnings for gaps', () => {
  const record = { patient: fx('patient-nobirth'), medications: [], conditions: [], weights: [] };
  const { data, summary } = fhir.toPatientData(record, { supported: SUPPORTED, now: NOW });
  assert.equal(data.age, null);
  assert.deepEqual(data.meds, []);
  assert.deepEqual(data.profile, { priorAdmits12mo: 0, ejectionFraction: null, lengthOfStay: null, ckd: false, diabetes: false, copd: false, livesAlone: false });
  assert.equal(data.source, 'fhir');
  assert.deepEqual(summary.warnings, [
    'No birth date in the EHR: age unknown',
    'Language "so" isn\'t supported yet: using English',
    'No active medications in the EHR',
    'No heart-failure diagnosis found in the EHR',
  ]);
  assert.throws(() => fhir.toPatientData({ patient: { id: 'x' } }), /no name/);
});

// ---- HTTP -------------------------------------------------------------------

const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('GET /api/fhir/search maps results and ignores non-Patient entries', async () => {
  const res = await fetch(`${base}/api/fhir/search?name=delgado`);
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.deepEqual(list.map((r) => [r.fhirId, r.name, r.language, r.importedAs]), [
    ['hb-rosa-1', 'Rosa María Delgado', 'es', null],
    ['hb-luis-3', 'Luis Delgado', 'en', null],
  ]);
  assert.equal((await fetch(`${base}/api/fhir/search?name=d`)).status, 400);
});

test('POST /api/fhir/import creates a FHIR patient with meds, comorbidities, weights and a fresh risk score', async () => {
  const res = await post('/api/fhir/import', { fhirPatientId: 'hb-rosa-1' });
  assert.equal(res.status, 201);
  const { patient, summary } = await res.json();
  assert.equal(patient.source, 'fhir');
  assert.equal(patient.name, 'Rosa María Delgado');
  assert.equal(patient.language, 'es');
  assert.equal(patient.age, 78);
  assert.deepEqual(patient.meds.map((m) => m.name), ['Furosemide', 'Carvedilol', 'Lisinopril']);
  assert.equal(patient.dryWeightLb, 173.1);
  assert.equal(patient.profile.ckd, true);
  assert.equal(patient.profile.copd, false); // resolved COPD, and no template leakage
  assert.equal(patient.profile.ejectionFraction, null);
  // Baseline: age >= 75 (2) + CKD (2) + diabetes (1) = 5 -> Med
  assert.deepEqual(patient.riskFactors.map((f) => f.label), ['Age ≥ 75', 'Chronic kidney disease', 'Diabetes']);
  assert.equal(patient.riskTier, 'Med');
  assert.equal(summary.heartFailure, true);
  assert.deepEqual(summary.warnings, []);
  // It's a real patient now: in the list, audited, and it can be linked with its code.
  assert.ok(store.getPatient(patient.id));
  assert.ok(store.listAudit(patient.id).some((e) => e.type === 'fhir_import' && e.data.fhirId === 'hb-rosa-1'));
  assert.ok(patient.linkCode);

  // Importing the same EHR patient again points at the first import.
  const again = await post('/api/fhir/import', { fhirPatientId: 'hb-rosa-1' });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).patientId, patient.id);
  const search = await (await fetch(`${base}/api/fhir/search?name=delgado`)).json();
  assert.equal(search[0].importedAs, patient.id);
});

test('import with no birth date: age stays unknown and the risk score has no invented age factor', async () => {
  // No heart-failure diagnosis: blocked until the nurse confirms (override).
  const blocked = await post('/api/fhir/import', { fhirPatientId: 'hb-ahmed-2' });
  assert.equal(blocked.status, 422);
  assert.equal((await blocked.json()).needsOverride, true);
  const res = await post('/api/fhir/import', { fhirPatientId: 'hb-ahmed-2', override: true });
  assert.equal(res.status, 201);
  const { patient, summary } = await res.json();
  assert.equal(patient.age, null);
  assert.equal(store.getPatient(patient.id).age, null);
  assert.ok(!patient.riskFactors.some((f) => f.label.startsWith('Age')));
  assert.equal(patient.riskTier, 'Low');
  assert.deepEqual(patient.meds, []); // not the demo template's meds
  assert.equal(patient.language, 'en');
  assert.equal(summary.warnings.length, 4);
});

test('preview shows what would be created without saving anything', async () => {
  const before = store.listPatients().length;
  const res = await fetch(`${base}/api/fhir/preview/hb-rosa-1`);
  assert.equal(res.status, 200);
  const { data, summary } = await res.json();
  assert.equal(data.name, 'Rosa María Delgado');
  assert.deepEqual(summary.medications, ['Furosemide 40 mg (diuretic)', 'Carvedilol 12.5 mg', 'Lisinopril 5 mg']);
  assert.equal(store.listPatients().length, before);
});

test('errors: unknown patient 404, bad id 400, missing id 400, no name 422, EHR down 502', async () => {
  assert.equal((await post('/api/fhir/import', { fhirPatientId: 'nobody' })).status, 404);
  assert.equal((await post('/api/fhir/import', { fhirPatientId: '../../etc/passwd' })).status, 400);
  assert.equal((await post('/api/fhir/import', {})).status, 400);
  assert.equal((await post('/api/fhir/import', { fhirPatientId: 'hb-noname-4' })).status, 422);

  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith(FHIR)) throw new TypeError('fetch failed');
    return realFetch(url, opts);
  };
  const down = await fetch(`${base}/api/fhir/search?name=delgado`);
  assert.equal(down.status, 502);
  assert.match((await down.json()).error, /unreachable/);
});

test('optional resources failing does not block the import', async () => {
  globalThis.fetch = fakeFhir({
    ...ROUTES,
    'MedicationRequest?subject=Patient%2Fhb-rosa-1': () => new Response('boom', { status: 500 }),
  });
  const res = await post('/api/fhir/import', { fhirPatientId: 'hb-rosa-1' });
  assert.equal(res.status, 201);
  const { patient, summary } = await res.json();
  assert.deepEqual(patient.meds, []);
  assert.ok(summary.warnings.includes('No active medications in the EHR'));
  assert.ok(fhirCalls.some((c) => c.startsWith('Observation?subject=Patient%2Fhb-rosa-1&code=http%3A%2F%2Floinc.org%7C29463-7')));
});

// ---------- export (write-back preview) ----------
test('GET /api/fhir/export/:id: weights, SpO2, BP, Flag and open Tasks as a FHIR R4 Bundle', async () => {
  const p = store.getPatient('p1');
  store.updatePatient('p1', {
    vitals: [{ ts: new Date().toISOString(), sbp: 118, dbp: 72 }],
    checkins: [...p.checkins, { ts: new Date().toISOString(), answers: { spo2: 94 }, tier: 'YELLOW', flags: [{ code: 'weight_24h', tier: 'YELLOW', text: 'Weight up 2.7 lb in 24h' }] }],
  });
  store.addAlert({ patientId: 'p1', tier: 'YELLOW', reasons: ['Weight up 2.7 lb in 24h'], title: 'Nurse call today' });
  const res = await fetch(`${base}/api/fhir/export/p1`);
  assert.equal(res.status, 200);
  const bundle = await res.json();
  assert.equal(bundle.resourceType, 'Bundle');
  assert.equal(bundle.type, 'collection');
  const of = (t) => bundle.entry.map((e) => e.resource).filter((r) => r.resourceType === t);
  const obs = of('Observation');
  const weights = obs.filter((o) => o.code.coding[0].code === '29463-7');
  assert.ok(weights.length >= 5);
  assert.equal(weights[0].valueQuantity.code, '[lb_av]');
  assert.equal(obs.find((o) => o.code.coding[0].code === '59408-5').valueQuantity.value, 94);
  assert.equal(obs.find((o) => o.code.coding[0].code === '85354-9').component[0].valueQuantity.value, 118);
  assert.match(of('Flag')[0].code.text, /YELLOW: Weight up/);
  assert.equal(of('Task')[0].priority, 'urgent');
  assert.equal(of('Patient')[0].communication[0].language.coding[0].code, 'es');
  assert.equal((await fetch(`${base}/api/fhir/export/nope`)).status, 404);
});
