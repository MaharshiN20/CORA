// Medication reminders + adherence (P1-3).
//
// At each med time the patient gets one reminder listing that slot's meds, with a
// ✅/❌ button per med and a "took them all" shortcut. Each med becomes a dose
// record { id, ts, med, dose, diuretic, taken: true|false|null, source, respondedAt }.
// taken=null means "no answer yet". It's never counted as missed, so a patient who
// ignores reminders doesn't trip the "missed diuretic" triage rule on silence alone
// (silence is handled by the outreach ladder instead).
//
// Button data: med:<doseId>:t | med:<doseId>:m | med:all:<reminderId>
import * as store from '../store.js';
import * as clock from './clock.js';
import * as scheduler from './scheduler.js';
import * as channels from '../channels/index.js';
import { t } from './i18n.js';
import { addPlanner, occurrences, isMonitored, localDayKey } from './planning.js';
import { skipDuringRedLock } from './escalation.js';

const shortId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8);
const medTimes = (p) => [...new Set((p.meds ?? []).flatMap((m) => m.times ?? []))].sort();
const slotMeds = (p, time) => (p.meds ?? []).filter((m) => m.times?.includes(time));

// ---------- scheduling ----------

scheduler.defineJob('med_reminder', {
  skipIf: skipDuringRedLock,
  collapse: true,
  collapseKey: (j) => `${j.patientId}:${j.payload.time}`, // 08:00 and 20:00 never swallow each other
  async run(job) {
    const p = store.getPatient(job.patientId);
    const meds = slotMeds(p, job.payload.time);
    if (!meds.length) return { skipped: 'no meds at this time' };
    const reminderId = shortId();
    const doses = meds.map((m) => ({
      id: shortId(),
      reminderId,
      ts: job.dueAt,
      med: m.name,
      dose: m.dose,
      diuretic: !!m.diuretic,
      taken: null,
      source: 'reminder',
    }));
    store.updatePatient(p.id, { doses: [...(p.doses ?? []), ...doses] });
    await channels.sendToPatient(p, reminderReply(p, job.payload.time, doses, reminderId));
    store.audit('med_reminder', p.id, { time: job.payload.time, meds: doses.map((d) => d.med) });
    return { doses: doses.length };
  },
});

addPlanner((p, fromMs, toMs) => {
  for (const { at, key } of occurrences(medTimes(p), fromMs, toMs)) {
    if (!isMonitored(p, at)) continue;
    const time = key.slice(-5);
    scheduler.schedule({ kind: 'med_reminder', patientId: p.id, dueAt: at, key: `med_reminder:${p.id}:${key}`, payload: { time } });
  }
});

function reminderReply(p, time, doses, reminderId) {
  const L = p.language;
  const list = (lang) => doses.map((d) => `• ${d.med} ${d.dose ?? ''}`.trim()).join('\n');
  return {
    text: t(L, 'med_reminder', { time, list: list(L) }),
    textEn: t('en', 'med_reminder', { time, list: list('en') }),
    buttons: [
      ...doses.map((d) => [
        { label: t(L, 'med_taken_label', { med: d.med }), data: `med:${d.id}:t` },
        { label: t(L, 'med_missed_label', { med: d.med }), data: `med:${d.id}:m` },
      ]),
      [{ label: t(L, 'med_took_all'), data: `med:all:${reminderId}` }],
    ],
  };
}

// ---------- answers ----------

const both = (p, key, vars) => ({ text: t(p.language, key, vars), textEn: t('en', key, vars) });

// Handle a med:* button tap. Returns Reply[].
export function handleButton(patient, data) {
  const [, idOrAll, arg] = data.split(':');
  const now = clock.nowISO();
  const doses = (patient.doses ?? []).map((d) => ({ ...d }));

  if (idOrAll === 'all') {
    const hit = doses.filter((d) => d.reminderId === arg && d.taken === null);
    if (!hit.length) return [both(patient, 'med_already')];
    for (const d of hit) Object.assign(d, { taken: true, respondedAt: now });
    store.updatePatient(patient.id, { doses });
    store.audit('med_response', patient.id, { reminderId: arg, taken: hit.map((d) => d.med) });
    return [both(patient, 'med_logged_all')];
  }

  const dose = doses.find((d) => d.id === idOrAll);
  if (!dose) return [both(patient, 'med_already')];
  const taken = arg === 't';
  Object.assign(dose, { taken, respondedAt: now });
  store.updatePatient(patient.id, { doses });
  store.audit('med_response', patient.id, { doseId: dose.id, med: dose.med, taken });

  if (taken) return [both(patient, 'med_logged_taken', { med: dose.med })];
  // Missed: the water pill gets the specific CHF advice; everything else gets generic safe advice.
  return [
    both(patient, 'med_logged_missed', { med: dose.med }),
    both(patient, dose.diuretic ? 'advice_missed_dose' : 'med_missed_other'),
  ];
}

// The check-in's "did you take your water pill?" answer merges into today's
// diuretic dose (from the reminder) instead of creating a duplicate record.
// Returns the new doses array; the caller persists it.
export function applyDiureticAnswer(patient, taken, nowIso = clock.nowISO()) {
  const doses = (patient.doses ?? []).map((d) => ({ ...d }));
  const today = localDayKey(Date.parse(nowIso));
  const todays = doses.filter((d) => d.diuretic && localDayKey(Date.parse(d.ts)) === today);
  if (todays.length) {
    for (const d of todays) Object.assign(d, { taken, respondedAt: nowIso, confirmedBy: 'checkin' });
    return doses;
  }
  const med = (patient.meds ?? []).find((m) => m.diuretic);
  doses.push({ id: shortId(), ts: nowIso, med: med?.name ?? 'water pill', dose: med?.dose, diuretic: true, taken, source: 'checkin', respondedAt: nowIso });
  return doses;
}

// Adherence over the last `days`, counting only answered doses.
// -> { overall: 0..1|null, byMed: { [med]: { taken, missed, unknown, rate } }, unconfirmed }
export function adherence(patient, days = 7) {
  const since = clock.now() - days * clock.DAY;
  const recent = (patient.doses ?? []).filter((d) => Date.parse(d.ts) >= since);
  const byMed = {};
  for (const d of recent) {
    const m = (byMed[d.med] ??= { taken: 0, missed: 0, unknown: 0, rate: null });
    if (d.taken === true) m.taken++;
    else if (d.taken === false) m.missed++;
    else m.unknown++;
  }
  for (const m of Object.values(byMed)) m.rate = m.taken + m.missed ? m.taken / (m.taken + m.missed) : null;
  const answered = recent.filter((d) => d.taken !== null && d.taken !== undefined);
  return {
    overall: answered.length ? answered.filter((d) => d.taken).length / answered.length : null,
    byMed,
    unconfirmed: recent.length - answered.length,
  };
}
