// Home-device readings -> the same rules as a check-in answer (core/triage.js decides; nothing
// here picks a tier). SpO2 and heart rate are judged on their own; a weight joins the patient's
// weight history first, so the 24 h / 7 day / dry-weight rules see it.
//
// A pulse-ox can push a reading every minute, so alerts are de-bounced: within an hour a reading
// that is no worse than the open device alert is added to it as another reason, not a new card.
import * as store from '../store.js';
import * as clock from './clock.js';
import * as channels from '../channels/index.js';
import { triage } from './triage.js';
import { escalate } from './escalation.js';
import { localDayKey } from './planning.js';
import { t, localize } from './i18n.js';
import { RANGES } from '../integrations/devices.js'; // one set of limits for the API and the virtual devices

const SOURCE = 'device reading';
const DEBOUNCE_MS = 60 * 60 * 1000;
const RANK = { GREEN: 0, YELLOW: 1, RED: 2 };
const MAX_PAST_MS = 30 * 24 * 60 * 60 * 1000;

// The one way in for a device reading (POST /api/devices/readings, the Withings webhook):
// validate, drop a repeat of the same readingId, store, audit, then judge it.
// { patientId, type: 'weight'|'spo2'|'hr', value, device?, ts?, readingId? } -> { status, body }:
//   201 { ...reading, tier } | 200 { ...reading, duplicate: true } | 400 / 404 { error }
export async function ingestReading({ patientId, type, value, device, ts, readingId } = {}) {
  const fail = (status, error) => ({ status, body: { error } });
  const patient = typeof patientId === 'string' ? store.getPatient(patientId) : null;
  if (!patient) return fail(404, 'unknown patientId');
  const range = RANGES[type];
  if (!range) return fail(400, `type must be one of ${Object.keys(RANGES)}`);
  const v = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(v) || v < range[0] || v > range[1]) return fail(400, `value out of range ${range}`);
  if (device !== undefined && (typeof device !== 'string' || device.length > 40)) return fail(400, 'device must be a string of at most 40 characters');
  if (readingId !== undefined && (typeof readingId !== 'string' || !readingId || readingId.length > 64)) return fail(400, 'readingId must be a string of 1-64 characters');
  let when;
  if (ts !== undefined) {
    const ms = typeof ts === 'string' || typeof ts === 'number' ? Date.parse(typeof ts === 'number' ? new Date(ts).toISOString() : ts) : NaN;
    if (!Number.isFinite(ms)) return fail(400, 'ts must be an ISO timestamp');
    if (ms > clock.now() + 5 * 60_000) return fail(400, 'ts is in the future');
    if (ms < clock.now() - MAX_PAST_MS) return fail(400, 'ts is more than 30 days old');
    when = new Date(ms).toISOString();
  }
  // A device that retries after a timeout must not create a second reading or a second alert.
  if (readingId) {
    const seen = store.listReadings(patientId).find((r) => r.readingId === readingId);
    if (seen) return { status: 200, body: { ...seen, duplicate: true } };
  }
  const reading = store.addReading({ patientId, type, value: v, source: 'device', device: device ?? 'unknown', ts: when, readingId });
  store.audit('device_reading', patientId, { type, value: v, device: reading.device });
  const { tier } = await triageReading(patient, reading);
  return { status: 201, body: { ...reading, tier } };
}

// reading: the row from store.addReading. -> { tier, alert, deduped }
export async function triageReading(patient, reading) {
  const copd = !!patient.profile?.copd;
  let result;
  if (reading.type === 'spo2') {
    result = triage({ weights: [], answers: { spo2: reading.value }, copd });
  } else if (reading.type === 'hr') {
    result = triage({ weights: [], answers: { heartRate: reading.value } });
  } else if (reading.type === 'weight') {
    const day = (ms) => localDayKey(ms);
    const weights = patient.weights.filter((w) => day(Date.parse(w.ts)) !== day(Date.parse(reading.ts)));
    weights.push({ ts: reading.ts, lb: reading.value });
    weights.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    store.updatePatient(patient.id, { weights });
    result = triage({ weights, answers: {}, dryWeightLb: patient.dryWeightLb, copd });
  } else {
    return { tier: 'GREEN', alert: null, deduped: false };
  }
  if (result.tier === 'GREEN') return { tier: 'GREEN', alert: null, deduped: false };

  const reasons = result.flags.map((f) => f.text);
  const open = store
    .listAlerts()
    .filter((a) => a.patientId === patient.id && a.source === SOURCE && a.status !== 'resolved' && clock.now() - Date.parse(a.ts) < DEBOUNCE_MS)
    .sort((a, b) => RANK[b.tier] - RANK[a.tier])[0];

  if (open && RANK[open.tier] >= RANK[result.tier]) {
    const fresh = reasons.filter((r) => !open.reasons.includes(r));
    if (fresh.length) store.updateAlert(open.id, { reasons: [...open.reasons, ...fresh] });
    return { tier: result.tier, alert: store.getAlert(open.id), deduped: true };
  }

  const current = store.getPatient(patient.id);
  if (RANK[result.tier] > RANK[current.lastTier ?? 'GREEN']) store.updatePatient(patient.id, { lastTier: result.tier });
  const alert = await escalate(store.getPatient(patient.id), result, { source: SOURCE });
  if (result.tier === 'RED') {
    const name = patient.name.split(' ')[0];
    const lang = patient.language;
    const text = await localize(lang, t(lang, 'red_interrupt', { name }));
    await channels.sendToPatient(store.getPatient(patient.id), { text, textEn: t('en', 'red_interrupt', { name }), urgent: true });
  }
  return { tier: result.tier, alert, deduped: false };
}
