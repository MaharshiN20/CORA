// Enrollment: creating patients (FHIR import, dashboard) and on-the-fly demo patients
// for judges who scan the QR code. Contract: docs/CONTRACTS.md.
import * as store from '../store.js';
import { buildSeed, makePatient } from '../seed.js';
import * as clock from './clock.js';

// Languages a patient can pick. native = hand-written templates (work offline);
// others are translated by the LLM chain (English if no LLM is available).
const LANGUAGES = [
  { code: 'en', name: 'English', nativeName: 'English', native: true },
  { code: 'es', name: 'Spanish', nativeName: 'Español', native: true },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt', native: false },
  { code: 'zh', name: 'Chinese (Simplified)', nativeName: '中文', native: false },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', native: false },
  { code: 'ko', name: 'Korean', nativeName: '한국어', native: false },
  { code: 'ht', name: 'Haitian Creole', nativeName: 'Kreyòl ayisyen', native: false },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', native: false },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', native: false },
  { code: 'tl', name: 'Tagalog', nativeName: 'Tagalog', native: false },
];

export const languages = () => LANGUAGES;
export const isSupportedLanguage = (code) => LANGUAGES.some((l) => l.code === code);

const shortId = () => Math.random().toString(36).slice(2, 7).toUpperCase();

function uniqueCode(prefix) {
  let code;
  do code = `${prefix}${shortId()}`;
  while (store.getPatientByCode(code));
  return code;
}

// Create a patient from partial data (FHIR import, dashboard form). Required: name.
// Anything missing gets a sensible CHF default; baseline risk is computed by makePatient.
export function createPatient(data) {
  if (!data?.name) throw new Error('createPatient: name is required');
  const id = data.id ?? `p_${shortId().toLowerCase()}`;
  if (store.getPatient(id)) throw new Error(`createPatient: id ${id} already exists`);
  const template = buildSeed().patients.find((p) => p.id === 'p2'); // generic defaults
  const patient = makePatient({
    id,
    linkCode: data.linkCode ?? uniqueCode(data.name.split(' ').at(-1).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6) || 'PT'),
    name: data.name,
    age: data.age ?? 70,
    language: isSupportedLanguage(data.language) ? data.language : 'en',
    dischargedAt: data.dischargedAt ?? clock.nowISO(),
    profile: { ...template.profile, priorAdmits12mo: 0, ...data.profile },
    dryWeightLb: data.dryWeightLb ?? data.weights?.at(-1)?.lb ?? null,
    weights: data.weights ?? [],
    meds: data.meds ?? template.meds,
    prescriptions: data.prescriptions ?? [],
    caregiver: data.caregiver ?? { name: null, relation: null, language: 'en' },
    source: data.source ?? 'manual',
    ...(data.dischargeInstructions && { dischargeInstructions: data.dischargeInstructions }),
  });
  store.addPatient(patient);
  store.audit('enroll', patient.id, { source: patient.source });
  return patient;
}

// Judge mode: clone Maria's story (weight trending up, unfilled diuretic) so a judge's
// first check-in on their own phone produces a real YELLOW alert on the big screen.
export function enrollDemoPatient({ chatId = null, language = 'en', name } = {}) {
  const maria = buildSeed().patients.find((p) => p.id === 'p1');
  const code = uniqueCode('DEMO');
  const lang = isSupportedLanguage(language) ? language : 'en';
  const patient = makePatient({
    ...structuredClone(maria),
    id: `demo_${code.slice(4).toLowerCase()}`,
    linkCode: code,
    name: name || `Guest ${code.slice(4)}`,
    language: lang,
    chatId,
    caregiver: { name: null, relation: null, language: 'en', chatId: null },
    source: 'demo',
  });
  store.addPatient(patient);
  store.audit('enroll', patient.id, { source: 'demo', language: lang });
  return patient;
}
