// Weekly caregiver digest (P1-7): a short, plain-language summary of the week
// (weight trend, check-ins answered, medicines, alerts, refills), in the
// caregiver's language. Sent Sundays 18:00, or on demand from the dashboard.
import * as store from '../store.js';
import * as clock from './clock.js';
import * as scheduler from './scheduler.js';
import * as channels from '../channels/index.js';
import { t, hasNative, localize } from './i18n.js';
import { adherence } from './meds.js';
import { addPlanner, occurrences, isMonitored } from './planning.js';
import { skipDuringRedLock } from './escalation.js';

const DIGEST_TIME = '18:00';
const DIGEST_WEEKDAY = 0; // Sunday

const firstName = (p) => p.name.split(' ')[0];
const fmt = (n) => (Math.round(n * 10) / 10).toFixed(1);

// Build the digest lines for a language. Pure (no sending) so the dashboard can preview it.
export function buildDigest(patient, lang = patient.caregiver?.language ?? 'en', days = 7) {
  const since = clock.now() - days * clock.DAY;
  const name = firstName(patient);
  const L = (key, vars) => t(lang, key, { name, ...vars });

  const weights = (patient.weights ?? []).filter((w) => Date.parse(w.ts) >= since);
  const weightLine =
    weights.length >= 2
      ? L('digest_weight', {
          start: fmt(weights[0].lb),
          end: fmt(weights.at(-1).lb),
          delta: `${weights.at(-1).lb - weights[0].lb >= 0 ? '+' : ''}${fmt(weights.at(-1).lb - weights[0].lb)}`,
        })
      : L('digest_weight_none');

  const daysMonitored = Math.min(days, Math.max(1, Math.ceil((clock.now() - Date.parse(patient.dischargedAt)) / clock.DAY)));
  const checkinDays = new Set((patient.checkins ?? []).filter((c) => Date.parse(c.ts) >= since).map((c) => c.ts.slice(0, 10))).size;

  const adh = adherence(patient, days);
  const alerts = store.listAlerts(patient.id).filter((a) => Date.parse(a.ts) >= since && a.tier !== 'INFO');
  const unfilled = (patient.prescriptions ?? []).filter((rx) => !rx.pickedUpAt).map((rx) => rx.med);

  const lines = [
    L('digest_title'),
    weightLine,
    L('digest_checkins', { done: checkinDays, expected: daysMonitored }),
    adh.overall == null ? L('digest_adherence_none') : L('digest_adherence', { pct: Math.round(adh.overall * 100) }),
    alerts.length ? L('digest_alerts', { count: alerts.length, red: alerts.filter((a) => a.tier === 'RED').length }) : L('digest_alerts_none'),
    ...(unfilled.length ? [L('digest_refills', { meds: unfilled.join(', ') })] : []),
    L('digest_footer'),
  ];
  return lines.join('\n');
}

export async function sendDigest(patientId) {
  const p = store.getPatient(patientId);
  if (!p) throw Object.assign(new Error('patient not found'), { status: 404 });
  if (!p.caregiver?.name || p.caregiverConsent === false) {
    store.audit('digest', p.id, { skipped: 'no consented caregiver' });
    return { sent: false, reason: 'no consented caregiver' };
  }
  const lang = p.caregiver.language ?? 'en';
  const textEn = buildDigest(p, 'en');
  const text = hasNative(lang) ? buildDigest(p, lang) : await localize(lang, textEn);
  const delivered = await channels.sendToCaregiver(p, { text, textEn });
  store.audit('digest', p.id, { delivered, lang });
  return { sent: true, delivered, text, textEn };
}

scheduler.defineJob('digest_weekly', {
  skipIf: skipDuringRedLock,
  collapse: true,
  async run(job) {
    return sendDigest(job.patientId);
  },
});

addPlanner((p, fromMs, toMs) => {
  if (!p.caregiver?.name) return;
  for (const { at, key } of occurrences([DIGEST_TIME], fromMs, toMs)) {
    if (new Date(at).getDay() !== DIGEST_WEEKDAY || !isMonitored(p, at)) continue;
    scheduler.schedule({ kind: 'digest_weekly', patientId: p.id, dueAt: at, key: `digest_weekly:${p.id}:${key}` });
  }
});
