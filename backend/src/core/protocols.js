// One-click standing orders (clinic protocols), starting with HF-02: an extra diuretic dose
// for fluid gain. The safety story is the split of responsibilities:
//   - the clinic writes the protocol (conditions/chf/protocols/*.json: drug instructions,
//     eligibility, labs), never the LLM and never this code;
//   - this code only checks eligibility against the patient record and applies what the file
//     says, and the nurse is the one who clicks.
//
//   eligibility(patient, alert) -> { protocol, triggered, eligible, checks: [{ id, label, status, detail, required, action? }] }
//   apply(patientId, alertId, { by }) -> { alert, task, message, fhir }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from '../store.js';
import * as clock from './clock.js';
import * as channels from '../channels/index.js';
import { t, hasNative, localize } from './i18n.js';
import { atLocalTime } from './planning.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'conditions', 'chf', 'protocols');
export const PROTOCOLS = Object.fromEntries(
  fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')))
    .map((p) => [p.id, p]),
);
const DEFAULT_ID = 'HF-02';

const DAY = 24 * 60 * 60 * 1000;
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
const diureticOf = (p) => (p.meds ?? []).find((m) => m.diuretic);

// The check-in that produced this alert (same moment, or the last one before it).
function checkinFor(patient, alert) {
  const at = Date.parse(alert.ts) + 60_000;
  return (patient.checkins ?? []).filter((c) => Date.parse(c.ts) <= at).at(-1) ?? null;
}

// Latest blood pressure within the window (self-reported or device).
function latestBp(patient, maxAgeHours) {
  const since = clock.now() - maxAgeHours * 60 * 60 * 1000;
  return (patient.vitals ?? []).filter((v) => v.sbp && Date.parse(v.ts) >= since).at(-1) ?? null;
}

export function eligibility(patient, alert, protocolId = DEFAULT_ID) {
  const protocol = PROTOCOLS[protocolId];
  if (!protocol) throw httpError(400, `unknown protocol ${String(protocolId).slice(0, 40)}`);
  const summary = { id: protocol.id, version: protocol.version, title: protocol.title, authoredBy: protocol.authoredBy, demo: !!protocol.demo, disclaimer: protocol.disclaimer };
  const checkin = checkinFor(patient, alert);
  const flags = checkin?.flags ?? [];
  const matched = flags.filter((f) => protocol.triggers.includes(f.code));
  const triggered =
    (alert.kind ?? 'triage') === 'triage' && alert.tier === 'YELLOW' && alert.source !== 'ai_review' && matched.length > 0;
  if (!triggered) return { protocol: summary, triggered: false, eligible: false, checks: [] };

  const checks = [];
  const add = (id, label, status, detail, { required = true, action } = {}) => checks.push({ id, label, status, detail, required, ...(action && { action }) });

  add('trigger', 'Trigger', 'pass', matched.map((f) => f.text).join(' · '));

  // Exclusions: any red flag today, or an open RED alert.
  const red = flags.filter((f) => f.tier === 'RED');
  const openRed = store.listAlerts().some((a) => a.patientId === patient.id && a.tier === 'RED' && a.status !== 'resolved');
  const spo2 = checkin?.answers?.spo2;
  if (red.length || openRed) add('no_red_flags', 'No red flags today', 'fail', red.map((f) => f.text).join('; ') || 'Open RED alert');
  else if (spo2 != null && spo2 < protocol.exclusions.spo2Below) add('no_red_flags', 'No red flags today', 'fail', `SpO₂ ${spo2}%`);
  else add('no_red_flags', 'No red flags today', 'pass', `No chest pain, fainting, confusion or breathlessness at rest${spo2 != null ? ` · SpO₂ ${spo2}%` : ''}`);

  // Took today's scheduled diuretic (the order is an EXTRA dose, never a replacement).
  const taken = checkin?.answers?.diureticTaken;
  if (protocol.requiresDiureticTakenToday) {
    if (taken === true) add('diuretic_taken', "Took today's diuretic", 'pass', diureticOf(patient)?.name ?? 'water pill');
    else if (taken === false) add('diuretic_taken', "Took today's diuretic", 'fail', 'Missed today: usual dose first');
    else add('diuretic_taken', "Took today's diuretic", 'unknown', 'Not answered yet');
  }

  // Labs within the protocol window.
  const L = protocol.labs;
  const labs = patient.labs;
  const LABEL = 'Recent K⁺ / creatinine';
  const labAt = Date.parse(labs?.at);
  if (!labs?.at) add('labs', LABEL, 'unknown', 'No labs on file');
  // Missing or non-numeric values compare false against every limit below, which used to fall
  // through to "pass": an unreadable lab must never count as a normal one.
  else if (!Number.isFinite(Number(labs.potassium)) || labs.potassium == null || !Number.isFinite(Number(labs.creatinine)) || labs.creatinine == null) add('labs', LABEL, 'unknown', 'Potassium or creatinine missing');
  else if (!Number.isFinite(labAt) || labAt > clock.now() + 60_000) add('labs', LABEL, 'unknown', 'Lab date is not valid');
  else {
    const K = Number(labs.potassium);
    const Cr = Number(labs.creatinine);
    const ageDays = Math.floor((clock.now() - labAt) / DAY);
    const detail = `K⁺ ${K} · Cr ${Cr} (${ageDays}d ago)`;
    if (ageDays > L.maxAgeDays) add('labs', LABEL, 'fail', `${detail}: older than ${L.maxAgeDays} days`);
    else if (K < L.potassium[0] || K > L.potassium[1]) add('labs', LABEL, 'fail', `${detail}: K⁺ outside ${L.potassium.join('–')}`);
    else if (Cr > L.creatinineMax) add('labs', LABEL, 'fail', `${detail}: Cr above ${L.creatinineMax}`);
    else add('labs', LABEL, 'pass', detail);
  }

  // Blood pressure: optional in HF-02; unknown shows an "ask the patient" action.
  const B = protocol.bloodPressure;
  const bp = latestBp(patient, B.maxAgeHours);
  if (!bp) add('bp', 'Systolic BP', 'unknown', 'Not reported today', { required: B.required, action: 'ask_bp' });
  else if (bp.sbp < B.sbpMin) add('bp', 'Systolic BP', 'fail', `${bp.sbp}/${bp.dbp} (below ${B.sbpMin})`, { required: B.required });
  else add('bp', 'Systolic BP', 'pass', `${bp.sbp}/${bp.dbp}`, { required: B.required });

  if (!diureticOf(patient)) add('diuretic_on_file', 'Diuretic on the med list', 'fail', 'No diuretic prescribed');

  const applied = alert.protocol?.appliedAt ? alert.protocol : null;
  const eligible = !applied && !checks.some((c) => c.status === 'fail') && checks.every((c) => c.status === 'pass' || !c.required);
  return { protocol: summary, triggered, eligible, applied, checks };
}

// FHIR previews of what the click would write to the EHR (not sent anywhere).
function fhirPreview(patient, protocol, med, instructionsEn, by, followUpAt) {
  const subject = { reference: `Patient/${patient.fhirId ?? patient.id}`, display: patient.name };
  return {
    medicationRequest: {
      resourceType: 'MedicationRequest',
      status: 'draft',
      intent: 'order',
      subject,
      medicationCodeableConcept: { text: `${med.name} ${med.dose}` },
      authoredOn: clock.nowISO(),
      requester: { display: by },
      reasonCode: [{ text: 'Fluid gain on home monitoring (HeartBridge)' }],
      note: [{ text: `Per standing order ${protocol.id} (${protocol.version})${protocol.demo ? ' [DEMO protocol]' : ''}` }],
      dosageInstruction: [{ text: instructionsEn }],
    },
    communicationRequest: {
      resourceType: 'CommunicationRequest',
      status: 'active',
      subject,
      payload: [{ contentString: `Re-weigh ${new Date(followUpAt).toISOString()} and report to the care team.` }],
      occurrenceDateTime: new Date(followUpAt).toISOString(),
      requester: { display: by },
    },
  };
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Alerts being applied right now. The eligibility check and the "applied" stamp are separated by
// awaits (the send), so two clicks in the same moment would both pass and both message the patient.
const applying = new Set();

export async function apply(alertId, { by = 'Nurse', protocolId = DEFAULT_ID } = {}) {
  if (typeof by !== 'string') throw httpError(400, 'by must be a string');
  if (!PROTOCOLS[protocolId]) throw httpError(400, `unknown protocol ${String(protocolId).slice(0, 40)}`);
  const alert = store.getAlert(alertId);
  if (!alert) throw httpError(404, 'alert not found');
  if (applying.has(alertId)) throw httpError(409, `not eligible for ${protocolId}: already being applied`);
  const patient = store.getPatient(alert.patientId);
  const check = eligibility(patient, alert, protocolId);
  if (!check.eligible) {
    const why = check.applied ? 'already applied' : !check.triggered ? 'protocol not triggered by this alert' : check.checks.filter((c) => c.status !== 'pass' && c.required).map((c) => `${c.label}: ${c.detail}`).join('; ');
    throw Object.assign(httpError(409, `not eligible for ${protocolId}: ${why}`), { checks: check.checks });
  }
  applying.add(alertId); // synchronously after the check, before the first await
  try {
    return await applyEligible(alert, patient, check, by, protocolId);
  } finally {
    applying.delete(alertId);
  }
}

async function applyEligible(alert, patient, check, by, protocolId) {
  const protocol = PROTOCOLS[protocolId];
  const med = diureticOf(patient);
  const nurse = by.trim() || 'Your nurse';
  const vars = { med: med.name, dose: med.dose ?? '' };

  // Patient message: wrapper from i18n, the instructions verbatim from the clinic's file.
  const instructionsEn = fill(protocol.patientInstructions.en, vars);
  const key = 'protocol_notice';
  const text = hasNative(patient.language)
    ? t(patient.language, key, { nurse, instructions: fill(protocol.patientInstructions[patient.language] ?? protocol.patientInstructions.en, vars) })
    : await localize(patient.language, t('en', key, { nurse, instructions: instructionsEn }));
  const textEn = t('en', key, { nurse, instructions: instructionsEn });
  const delivered = await channels.sendToPatient(patient, { text, textEn });

  // Follow-up: re-weigh tomorrow 08:00 (local), 24h-style SLA via dueBy.
  const followUpAt = atLocalTime(clock.now() + DAY, protocol.followUp.at);
  const task = store.addTask({
    patientId: patient.id,
    kind: 'protocol_followup',
    tier: protocol.followUp.tier,
    title: protocol.followUp.title,
    reasons: [`${med.name} extra dose per ${protocol.id} (applied by ${nurse})`, `Check tomorrow's weight vs today's (${patient.weights?.at(-1)?.lb ?? '?'} lb)`],
    dueBy: new Date(followUpAt).toISOString(),
    protocolId: protocol.id,
    sourceAlertId: alert.id,
  });

  const fhir = fhirPreview(patient, protocol, med, instructionsEn, nurse, followUpAt);
  const appliedAt = clock.nowISO();
  store.updateAlert(alert.id, {
    status: 'contacted',
    by: nurse,
    note: `Standing order ${protocol.id} applied by ${nurse}`,
    protocol: { id: protocol.id, version: protocol.version, appliedAt, by: nurse, followUpTaskId: task.id },
  });
  store.audit('protocol_applied', patient.id, {
    alertId: alert.id,
    protocolId: protocol.id,
    version: protocol.version,
    by: nurse,
    med: `${med.name} ${med.dose}`,
    checks: check.checks.map(({ id, status, detail }) => ({ id, status, detail })),
    followUpTaskId: task.id,
    delivered,
  });
  return { alert: store.getAlert(alert.id), task, message: { text, textEn, delivered }, fhir };
}
