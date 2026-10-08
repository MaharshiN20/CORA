// EHR import via FHIR (Maharshi lane). Mounted at /api/fhir.
//
//   GET  /api/fhir                     -> { ok, base }
//   GET  /api/fhir/search?name=        -> [{ fhirId, name, age, birthDate, gender, language }]
//   GET  /api/fhir/preview/:fhirId     -> { data, summary }   what an import would create (nothing saved)
//   POST /api/fhir/import { fhirPatientId, override? } -> 201 { patient, summary }
//        409 { error, patientId } if that EHR patient was already imported
//        422 { error, needsOverride, reasons } no heart-failure diagnosis / under 18 (unless override)
//   GET  /api/fhir/export/:patientId  -> FHIR R4 collection Bundle (preview of the write-back)
import { Router } from 'express';
import * as store from '../store.js';
import { createPatient, languages } from '../core/enroll.js';
import { scoreRisk } from '../core/risk.js';
import { baseUrl, searchPatients, fetchRecord, toPatientData, toFhirBundle, FhirError } from '../integrations/fhir.js';

export const fhir = Router();

const supported = () => languages().map((l) => l.code);

const fail = (res, err) => {
  if (err instanceof FhirError) return res.status(err.status).json({ error: err.message });
  console.error('[fhir]', err?.message ?? err); // detail stays in the log
  return res.status(500).json({ error: 'internal error' });
};

// An EHR patient that was already imported: the patient record carries fhirId/fhirBase (set below).
// Imports made before that was recorded are found through their audit row.
function alreadyImported(fhirId) {
  const base = baseUrl();
  const own = store.listPatients().find((p) => p.fhirId === fhirId && p.fhirBase === base);
  if (own) return own.id;
  const hit = store.listAudit().find((e) => e.type === 'fhir_import' && e.data?.fhirId === fhirId && e.data?.base === base);
  return hit && store.getPatient(hit.patientId) ? hit.patientId : null;
}

// Imports in flight, so a double click (two requests before either has finished fetching) can't
// create two patients: the check above only sees patients that already exist.
const importing = new Set();

fhir.get('/', (_req, res) => res.json({ ok: true, base: baseUrl() }));

fhir.get('/search', async (req, res) => {
  const name = String(req.query.name ?? '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'name must be at least 2 characters' });
  try {
    const results = await searchPatients(name, { supported: supported() });
    res.json(results.map((r) => ({ ...r, importedAs: alreadyImported(r.fhirId) })));
  } catch (err) {
    fail(res, err);
  }
});

fhir.get('/preview/:fhirId', async (req, res) => {
  try {
    res.json(toPatientData(await fetchRecord(req.params.fhirId), { supported: supported() }));
  } catch (err) {
    fail(res, err);
  }
});

fhir.post('/import', async (req, res) => {
  const fhirId = String(req.body?.fhirPatientId ?? '').trim();
  if (!fhirId) return res.status(400).json({ error: 'fhirPatientId is required' });
  const existing = alreadyImported(fhirId);
  if (existing) return res.status(409).json({ error: 'Already imported', patientId: existing });
  const claim = `${baseUrl()}|${fhirId}`;
  if (importing.has(claim)) return res.status(409).json({ error: 'This patient is already being imported' });
  importing.add(claim);
  try {
    const { data, summary } = toPatientData(await fetchRecord(fhirId), { supported: supported() });
    // HeartBridge is a heart-failure program for adults: enrolling anyone else (a public
    // sandbox is full of them) needs a nurse to confirm on purpose.
    const reasons = [...(summary.heartFailure ? [] : ['No heart-failure diagnosis in the EHR']), ...(data.age != null && data.age < 18 ? [`Age ${data.age}: under 18`] : [])];
    if (reasons.length && req.body?.override !== true) {
      return res.status(422).json({ error: `Not enrolled: ${reasons.join('; ')}. Confirm to enroll anyway.`, needsOverride: true, reasons });
    }
    // Re-check now that the fetch is done: another path may have created the patient meanwhile.
    const raced = alreadyImported(fhirId);
    if (raced) return res.status(409).json({ error: 'Already imported', patientId: raced });
    let patient = createPatient(data);
    patient = store.updatePatient(patient.id, { fhirId, fhirBase: baseUrl() });
    // createPatient assumes age 70 when none is given; an unknown age must stay unknown,
    // and the baseline risk must not count an age factor we invented.
    if (data.age == null) {
      const unknownAge = { ...patient, age: null };
      const risk = scoreRisk(unknownAge);
      patient = store.updatePatient(patient.id, { age: null, riskScore: risk.score, riskTier: risk.tier, riskFactors: risk.factors });
    }
    store.audit('fhir_import', patient.id, { fhirId, base: summary.base, conditions: summary.conditions.map((c) => c.flag), warnings: summary.warnings, ...(reasons.length && { override: reasons }) });
    res.status(201).json({ patient, summary });
  } catch (err) {
    fail(res, err);
  } finally {
    importing.delete(claim);
  }
});

fhir.get('/export/:patientId', (req, res) => {
  const p = store.getPatient(req.params.patientId);
  if (!p) return res.status(404).json({ error: 'patient not found' });
  res.json(toFhirBundle(p, { alerts: store.listAlerts(p.id) }));
});
