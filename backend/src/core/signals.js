// Behavioural + clinical signals about a patient, for dynamic risk (core/risk.js)
// and insights. Contract (docs/CONTRACTS.md): shape is stable; values get richer
// as features land. `null` means "no data yet", never "zero".
//
//   getSignals(patient) -> {
//     daysSinceDischarge, checkinsCompleted7d, missedCheckins7d, adherence7d (0-1|null), unconfirmedDoses7d,
//     weightDelta24h, weightDelta7d, openAlerts, openRedAlerts, sdohFlags: string[],
//     lessonScore (0-1|null), rpmDays30, lastCheckinAt, lastTier,
//     silentDays (whole days since the last finished check-in, or since discharge if there never
//     was one; null in the first 3 days after discharge, when silence means nothing yet)
//   }
import * as store from '../store.js';
import * as clock from './clock.js';
import { weightChange24h, weightChange7d } from './triage.js';
import { atLocalTime, localDayKey, tzOf } from './planning.js';

const dayKey = (iso) => iso.slice(0, 10);
const SILENT_GRACE_DAYS = 3;

export function getSignals(patient) {
  const now = clock.now();
  const since7d = now - 7 * clock.DAY;
  const since30d = now - 30 * clock.DAY;
  const discharged = Date.parse(patient.dischargedAt);
  const daysSinceDischarge = Math.max(0, Math.floor((now - discharged) / clock.DAY));

  // Check-ins: over the last 7 *finished* local days, one expected per day after the
  // discharge day. Today isn't counted as missed while it's still today.
  const tz = tzOf(patient);
  const todayStart = atLocalTime(now, '00:00', tz);
  const dischargeDayStart = atLocalTime(discharged, '00:00', tz);
  const recent = (patient.checkins ?? []).filter((c) => Date.parse(c.ts) >= since7d);
  const completedDays = new Set(recent.map((c) => localDayKey(Date.parse(c.ts), tz))).size;
  let expectedDays = 0;
  const doneBeforeToday = new Set();
  for (let d = 1; d <= 7; d++) {
    const dayStart = todayStart - d * clock.DAY;
    if (dayStart > dischargeDayStart) expectedDays++;
  }
  for (const c of patient.checkins ?? []) {
    const t = Date.parse(c.ts);
    if (t >= todayStart - 7 * clock.DAY && t < todayStart && t >= dischargeDayStart + clock.DAY) doneBeforeToday.add(localDayKey(t, tz));
  }
  const missedCheckins7d = Math.max(0, expectedDays - doneBeforeToday.size);

  // Adherence counts answered doses only; unanswered reminders are reported separately.
  const doses7d = (patient.doses ?? []).filter((d) => Date.parse(d.ts) >= since7d);
  const answered = doses7d.filter((d) => typeof d.taken === 'boolean');
  const adherence7d = answered.length ? answered.filter((d) => d.taken).length / answered.length : null;
  const unconfirmedDoses7d = doses7d.length - answered.length;

  const alerts = store.listAlerts(patient.id).filter((a) => a.status !== 'resolved');

  // RPM billing needs data on >= 16 distinct days per 30 (device readings or daily weights).
  const readingDays = new Set([
    ...store.listReadings(patient.id).filter((r) => Date.parse(r.ts) >= since30d).map((r) => dayKey(r.ts)),
    ...(patient.weights ?? []).filter((w) => Date.parse(w.ts) >= since30d).map((w) => dayKey(w.ts)),
  ]);

  const lastCheckinMs = Math.max(0, ...(patient.checkins ?? []).map((c) => Date.parse(c.ts)).filter(Number.isFinite));
  const silentSince = lastCheckinMs || discharged;
  const silentDays = daysSinceDischarge >= SILENT_GRACE_DAYS ? Math.max(0, Math.floor((now - silentSince) / clock.DAY)) : null;

  return {
    daysSinceDischarge,
    checkinsCompleted7d: completedDays,
    missedCheckins7d,
    adherence7d,
    unconfirmedDoses7d,
    weightDelta24h: weightChange24h(patient.weights ?? []),
    weightDelta7d: weightChange7d(patient.weights ?? []),
    openAlerts: alerts.length,
    openRedAlerts: alerts.filter((a) => a.tier === 'RED').length,
    sdohFlags: patient.sdoh?.flags ?? [],
    lessonScore: patient.lessons?.score ?? null,
    rpmDays30: readingDays.size,
    lastCheckinAt: patient.lastCheckinAt ?? null,
    lastTier: patient.lastTier ?? null,
    silentDays,
  };
}
