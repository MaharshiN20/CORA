// EHR import over FHIR R4 (Maharshi lane): "enroll straight from the EHR".
// Reads from any FHIR R4 server; defaults to the public HAPI sandbox (FHIR_BASE_URL to change).
// Read-only: nothing is ever written back to the EHR.
//
//   searchPatients(name)          -> [{ fhirId, name, age, birthDate, gender, language }]
//   fetchRecord(fhirId)           -> { patient, medications, conditions, weights }  (raw resources)
//   toPatientData(record, now)    -> data for core/enroll.createPatient({ ..., source: 'fhir' })
//
// The map* functions are pure and tested against recorded fixtures
// (backend/test/fixtures/fhir), so tests never touch the network.
import * as clock from '../core/clock.js';

export const baseUrl = () => (process.env.FHIR_BASE_URL || 'https://hapi.fhir.org/baseR4').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.FHIR_TIMEOUT_MS) || 15_000;

export class FhirError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status; // HTTP status to return from our API
  }
}

async function get(path) {
  let res;
  try {
    res = await fetch(`${baseUrl()}/${path}`, { headers: { Accept: 'application/fhir+json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new FhirError(`EHR server unreachable (${err.name === 'TimeoutError' ? 'timed out' : err.message})`, 502);
  }
  if (res.status === 404 || res.status === 410) throw new FhirError('Not found in the EHR', 404);
  if (!res.ok) throw new FhirError(`EHR server returned ${res.status}`, 502);
  return res.json();
}

const entries = (bundle) => (bundle?.entry ?? []).map((e) => e.resource).filter(Boolean);

// ---------- mapping (pure) ----------

export function mapName(p) {
  const n = (p?.name ?? []).find((x) => x.use === 'official') ?? p?.name?.[0];
  if (!n) return null;
  const built = [...(n.given ?? []), n.family].filter(Boolean).join(' ').trim();
  return built || n.text?.trim() || null;
}

export function ageFrom(birthDate, now = clock.now()) {
  if (!birthDate || !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(birthDate)) return null;
  const [y, m = 1, d = 1] = birthDate.split('-').map(Number);
  const today = new Date(now);
  let age = today.getUTCFullYear() - y;
  if (today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d)) age--;
  return age >= 0 && age < 130 ? age : null;
}

// FHIR language codes are BCP-47 ("es", "es-MX", "zh-CN"); some servers only send text.
const LANGUAGE_NAMES = { english: 'en', spanish: 'es', español: 'es', vietnamese: 'vi', chinese: 'zh', mandarin: 'zh', cantonese: 'zh', hindi: 'hi', korean: 'ko', 'haitian creole': 'ht', arabic: 'ar', portuguese: 'pt', tagalog: 'tl', filipino: 'tl' };

export function mapLanguage(p, supported = []) {
  const comms = p?.communication ?? [];
  const preferred = comms.find((c) => c.preferred) ?? comms[0];
  if (!preferred) return { language: 'en', raw: null, mapped: false };
  const coding = preferred.language?.coding ?? [];
  const candidates = [
    ...coding.map((c) => c.code?.toLowerCase().split('-')[0]),
    ...[preferred.language?.text, ...coding.map((c) => c.display)].map((t) => LANGUAGE_NAMES[t?.toLowerCase().trim()]),
  ].filter(Boolean);
  const hit = candidates.find((c) => supported.includes(c));
  const raw = coding[0]?.code ?? preferred.language?.text ?? null;
  return hit ? { language: hit, raw, mapped: true } : { language: 'en', raw, mapped: false };
}

export function mapPatientSummary(p, supported, now) {
  return {
    fhirId: p.id,
    name: mapName(p),
    birthDate: p.birthDate ?? null,
    age: ageFrom(p.birthDate, now),
    gender: p.gender ?? null,
    language: mapLanguage(p, supported).language,
  };
}

const DIURETIC = /furosemide|lasix|bumetanide|bumex|torsemide|torasemide|demadex|hydrochlorothiazide|chlorthalidone|metolazone|spironolactone|eplerenone/i;
const ACTIVE_RX = new Set(['active', 'on-hold', 'draft', 'unknown']);

const medText = (mr) =>
  mr.medicationCodeableConcept?.text ?? mr.medicationCodeableConcept?.coding?.find((c) => c.display)?.display ?? mr.medicationCodeableConcept?.coding?.[0]?.code ?? mr.medicationReference?.display ?? null;

// "Furosemide 40 MG Oral Tablet" -> name "Furosemide", dose "40 mg"
export function splitMedText(text) {
  const t = String(text ?? '').trim();
  const m = t.match(/^(.*?)\s+(\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|units?|iu)\b.*)$/i);
  const name = (m ? m[1] : t).replace(/\s+(oral|tablet|capsule)\b.*$/i, '').trim();
  const dose = m ? m[2].match(/^\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|units?|iu)/i)[0].toLowerCase().replace(/\s+/, ' ') : null;
  return { name: name ? name[0].toUpperCase() + name.slice(1) : null, dose };
}

function doseOf(mr, fromText) {
  const d = mr.dosageInstruction?.[0];
  const q = d?.doseAndRate?.[0]?.doseQuantity;
  if (q?.value != null) return `${q.value} ${q.unit ?? q.code ?? ''}`.trim();
  return fromText ?? d?.text ?? '';
}

// Reminder slots from the prescribed frequency: 1/day -> 08:00, 2/day -> 08:00 + 20:00, 3/day adds 14:00.
function timesOf(mr) {
  const r = mr.dosageInstruction?.[0]?.timing?.repeat;
  const perDay = r?.periodUnit === 'd' || !r?.periodUnit ? (r?.frequency ?? 1) / (r?.period ?? 1) : 1;
  if (perDay >= 3) return ['08:00', '14:00', '20:00'];
  if (perDay >= 2) return ['08:00', '20:00'];
  return ['08:00'];
}

export function mapMedications(requests = [], now = clock.now()) {
  const meds = [];
  const prescriptions = [];
  const seen = new Set();
  for (const mr of requests) {
    if (mr?.resourceType !== 'MedicationRequest' || (mr.status && !ACTIVE_RX.has(mr.status))) continue;
    const text = medText(mr);
    if (!text) continue;
    const { name, dose } = splitMedText(text);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const diuretic = DIURETIC.test(text);
    meds.push({ name, dose: doseOf(mr, dose), times: timesOf(mr), ...(diuretic && { diuretic: true }) });
    // A new discharge prescription is expected at the pharmacy; nothing has been picked up yet.
    const expected = mr.dispenseRequest?.validityPeriod?.start ?? mr.authoredOn ?? new Date(now).toISOString();
    prescriptions.push({ med: name, expectedPickup: new Date(Date.parse(expected) || now).toISOString(), pickedUpAt: null });
  }
  return { meds, prescriptions };
}

// Comorbidities that feed the baseline risk score. SNOMED CT + ICD-10-CM + free text.
const CONDITIONS = {
  ckd: { snomed: ['709044004', '431855005', '431856006', '433144002', '431857002', '433146000', '46177005'], icd10: /^N18/, text: /chronic kidney|\bckd\b|renal insufficiency|kidney disease/i },
  diabetes: { snomed: ['44054006', '73211009', '46635009', '190330002'], icd10: /^E1[01]/, text: /diabet/i },
  copd: { snomed: ['13645005', '185086009', '87433001'], icd10: /^J44/, text: /\bcopd\b|chronic obstructive|emphysema/i },
  heartFailure: { snomed: ['84114007', '42343007', '88805009', '85232009', '446221000'], icd10: /^I50/, text: /heart failure|\bchf\b|\bhfref\b|\bhfpef\b|cardiac failure/i },
};
const INACTIVE = new Set(['inactive', 'resolved', 'remission', 'entered-in-error']);

export function mapConditions(conditions = []) {
  const flags = { ckd: false, diabetes: false, copd: false, heartFailure: false };
  const matched = [];
  for (const c of conditions) {
    if (c?.resourceType !== 'Condition') continue;
    const status = c.clinicalStatus?.coding?.[0]?.code;
    if (INACTIVE.has(status) || c.verificationStatus?.coding?.[0]?.code === 'entered-in-error' || c.verificationStatus?.coding?.[0]?.code === 'refuted') continue;
    const codings = c.code?.coding ?? [];
    const texts = [c.code?.text, ...codings.map((x) => x.display)].filter(Boolean).join(' ');
    for (const [flag, rule] of Object.entries(CONDITIONS)) {
      const hit =
        codings.some((x) => (x.system?.includes('snomed') && rule.snomed.includes(x.code)) || (x.system?.includes('icd-10') && rule.icd10.test(x.code ?? ''))) || rule.text.test(texts);
      if (hit && !flags[flag]) {
        flags[flag] = true;
        matched.push({ flag, text: c.code?.text ?? codings[0]?.display ?? codings[0]?.code });
      }
    }
  }
  return { flags, matched };
}

// Body weight observations (LOINC 29463-7) -> [{ ts, lb }] oldest -> newest.
const TO_LB = { kg: 2.20462, '[lb_av]': 1, lb: 1, lbs: 1, g: 0.00220462 };
export function mapWeights(observations = []) {
  return observations
    .filter((o) => o?.resourceType === 'Observation' && o.valueQuantity?.value != null && o.status !== 'entered-in-error')
    .map((o) => {
      const unit = o.valueQuantity.code ?? o.valueQuantity.unit ?? 'kg';
      const factor = TO_LB[unit] ?? TO_LB[String(unit).toLowerCase()];
      const ts = o.effectiveDateTime ?? o.issued;
      return factor && ts ? { ts: new Date(ts).toISOString(), lb: Math.round(o.valueQuantity.value * factor * 10) / 10 } : null;
    })
    .filter((w) => w && w.lb >= 50 && w.lb <= 700)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

// Everything createPatient needs. Every profile field is explicit: createPatient fills gaps
// from a demo template, and we don't want someone else's EF or comorbidities leaking in.
export function toPatientData(record, { supported = [], now = clock.now() } = {}) {
  const p = record.patient;
  const name = mapName(p);
  if (!name) throw new FhirError('This EHR patient has no name, so they cannot be enrolled', 422);
  const lang = mapLanguage(p, supported);
  const { meds, prescriptions } = mapMedications(record.medications, now);
  const { flags, matched } = mapConditions(record.conditions);
  const weights = mapWeights(record.weights);
  return {
    data: {
      name,
      age: ageFrom(p.birthDate, now), // null when the EHR has no birth date
      language: lang.language,
      profile: {
        priorAdmits12mo: 0,
        ejectionFraction: null,
        lengthOfStay: null,
        ckd: flags.ckd,
        diabetes: flags.diabetes,
        copd: flags.copd,
        livesAlone: false,
      },
      meds,
      prescriptions,
      weights,
      dryWeightLb: weights.at(-1)?.lb ?? null,
      source: 'fhir',
    },
    // What the dashboard shows the nurse before/after importing.
    summary: {
      fhirId: p.id,
      base: baseUrl(),
      language: lang,
      conditions: matched,
      heartFailure: flags.heartFailure,
      medications: meds.map((m) => `${m.name}${m.dose ? ` ${m.dose}` : ''}${m.diuretic ? ' (diuretic)' : ''}`),
      weights: weights.length,
      warnings: [
        ...(p.birthDate ? [] : ['No birth date in the EHR: age unknown']),
        ...(lang.mapped || !lang.raw ? [] : [`Language "${lang.raw}" isn't supported yet: using English`]),
        ...(meds.length ? [] : ['No active medications in the EHR']),
        ...(flags.heartFailure ? [] : ['No heart-failure diagnosis found in the EHR']),
      ],
    },
  };
}

// ---------- export: HeartBridge -> EHR (preview) ----------
// The other half of the loop: what HeartBridge would write back to the EHR after home
// monitoring. A FHIR R4 collection Bundle; nothing is sent (the dashboard shows it).
const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';
const TASK_STATUS = { open: 'requested', acknowledged: 'accepted', contacted: 'in-progress', resolved: 'completed' };
const TASK_PRIORITY = { RED: 'stat', YELLOW: 'urgent', INFO: 'routine' };
const vitalSigns = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs', display: 'Vital Signs' }] }];

export function toFhirBundle(patient, { alerts = [], now = clock.now() } = {}) {
  const pid = patient.fhirId ?? patient.id;
  const subject = { reference: `Patient/${pid}`, display: patient.name };
  const resources = [];
  const add = (r) => resources.push(r);

  add({
    resourceType: 'Patient',
    id: pid,
    identifier: [{ system: 'urn:heartbridge:link-code', value: patient.linkCode }],
    name: [{ text: patient.name }],
    communication: [{ language: { coding: [{ system: 'urn:ietf:bcp:47', code: patient.language }] }, preferred: true }],
  });

  // Home weights of the last 7 days (LOINC 29463-7 body weight).
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  for (const w of (patient.weights ?? []).filter((x) => Date.parse(x.ts) >= weekAgo)) {
    add({
      resourceType: 'Observation',
      status: 'final',
      category: vitalSigns,
      code: { coding: [{ system: LOINC, code: '29463-7', display: 'Body weight' }], text: 'Body weight (home scale, patient-reported)' },
      subject,
      effectiveDateTime: w.ts,
      valueQuantity: { value: w.lb, unit: 'lb', system: UCUM, code: '[lb_av]' },
    });
  }

  // Latest self-reported SpO2 (LOINC 59408-5) and blood pressure (85354-9 panel).
  const spo2 = [...(patient.checkins ?? [])].reverse().find((c) => typeof c.answers?.spo2 === 'number');
  if (spo2) {
    add({
      resourceType: 'Observation',
      status: 'final',
      category: vitalSigns,
      code: { coding: [{ system: LOINC, code: '59408-5', display: 'Oxygen saturation in Arterial blood by Pulse oximetry' }] },
      subject,
      effectiveDateTime: spo2.ts,
      valueQuantity: { value: spo2.answers.spo2, unit: '%', system: UCUM, code: '%' },
    });
  }
  const bp = (patient.vitals ?? []).filter((v) => v.sbp).at(-1);
  if (bp) {
    add({
      resourceType: 'Observation',
      status: 'final',
      category: vitalSigns,
      code: { coding: [{ system: LOINC, code: '85354-9', display: 'Blood pressure panel' }] },
      subject,
      effectiveDateTime: bp.ts,
      component: [
        { code: { coding: [{ system: LOINC, code: '8480-6', display: 'Systolic blood pressure' }] }, valueQuantity: { value: bp.sbp, unit: 'mmHg', system: UCUM, code: 'mm[Hg]' } },
        { code: { coding: [{ system: LOINC, code: '8462-4', display: 'Diastolic blood pressure' }] }, valueQuantity: { value: bp.dbp, unit: 'mmHg', system: UCUM, code: 'mm[Hg]' } },
      ],
    });
  }

  // The latest non-GREEN check-in as a clinical Flag (what the care team should know on chart open).
  const last = (patient.checkins ?? []).at(-1);
  if (last && last.tier !== 'GREEN') {
    add({
      resourceType: 'Flag',
      status: 'active',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/flag-category', code: 'clinical', display: 'Clinical' }] }],
      code: { text: `HeartBridge home triage ${last.tier}: ${(last.flags ?? []).map((f) => f.text).join('; ')}` },
      subject,
      period: { start: last.ts },
    });
  }

  // Every open worklist item as a Task (who owes the patient what, by when).
  for (const a of alerts.filter((x) => x.patientId === patient.id && x.status !== 'resolved')) {
    add({
      resourceType: 'Task',
      status: TASK_STATUS[a.status] ?? 'requested',
      intent: 'order',
      priority: TASK_PRIORITY[a.tier] ?? 'routine',
      code: { text: a.kind ?? 'triage' },
      description: a.title,
      for: subject,
      authoredOn: a.ts,
      restriction: { period: { end: a.dueBy } },
      note: (a.reasons ?? []).map((text) => ({ text })),
    });
  }

  return {
    resourceType: 'Bundle',
    type: 'collection',
    timestamp: new Date(now).toISOString(),
    meta: { tag: [{ system: 'urn:heartbridge', code: 'preview', display: 'Preview only: not sent to an EHR' }] },
    entry: resources.map((resource, i) => ({ fullUrl: `urn:uuid:heartbridge-${pid}-${i}`, resource })),
  };
}

// ---------- network ----------

export async function searchPatients(name, { supported = [], now = clock.now(), count = 10 } = {}) {
  const bundle = await get(`Patient?name=${encodeURIComponent(name)}&_count=${count}`);
  return entries(bundle)
    .filter((r) => r.resourceType === 'Patient')
    .map((p) => mapPatientSummary(p, supported, now));
}

export async function fetchRecord(fhirId) {
  if (!/^[A-Za-z0-9\-.]{1,64}$/.test(String(fhirId ?? ''))) throw new FhirError('Invalid FHIR patient id', 400);
  const subject = encodeURIComponent(`Patient/${fhirId}`);
  const patient = await get(`Patient/${encodeURIComponent(fhirId)}`);
  // The rest is optional: a patient with no meds/conditions/weights still imports.
  const optional = (path) => get(path).then(entries).catch(() => []);
  const [medications, conditions, weights] = await Promise.all([
    optional(`MedicationRequest?subject=${subject}&_count=50`),
    optional(`Condition?subject=${subject}&_count=50`),
    optional(`Observation?subject=${subject}&code=${encodeURIComponent('http://loinc.org|29463-7')}&_sort=-date&_count=14`),
  ]);
  return { patient, medications, conditions, weights };
}
