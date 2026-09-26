// EHR import via FHIR (Maharshi lane). Mounted at /api/fhir.
// Planned: POST /api/fhir/import { patientId } -> integrations/fhir.js -> core/enroll.createPatient
import { Router } from 'express';

export const fhir = Router();

fhir.get('/', (_req, res) => res.json({ ok: true, todo: 'Maharshi lane: M5 FHIR import' }));
