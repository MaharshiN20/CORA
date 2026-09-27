// Behavioural + clinical signals about a patient, for dynamic risk (core/risk.js)
// and insights. Contract (docs/CONTRACTS.md): shape is stable; values get richer
// as features land. `null` means "no data yet", never "zero".
//
//   getSignals(patient) -> {
//     daysSinceDischarge, checkinsCompleted7d, missedCheckins7d, adherence7d (0-1|null), unconfirmedDoses7d,
//     weightDelta24h, weightDelta7d, openAlerts, openRedAlerts, sdohFlags: string[],
//     lessonScore (0-1|null), rpmDays30, lastCheckinAt, lastTier
//   }
import * as store from '../store.js';
import * as clock from './clock.js';
import { weightChange24h, weightChange7d } from './triage.js';

const dayKey = (iso) => iso.slice(0, 10);

export function getSignals(patient) {
  const now = clock.now();
  const since7d = now - 7 * clock.DAY;
  const since30d = now - 30 * clock.DAY;
  const discharged = Date.parse(patient.dischargedAt);
  const daysSinceDischarge = Math.max(0, Math.floor((now - discharged) / clock.DAY));

  // Check-ins: expected one per day since discharge (capped at 7), minus completed.
  const recent = (patient.checkins ?? []).filter((c) => Date.parse(c.ts) >= since7d);
  const completedDays = new Set(recent.map((c) => dayKey(c.ts))).size;
  const expectedDays = Math.min(7, daysSinceDischarge);
  const missedCheckins7d = Math.max(0, expectedDays - completedDays);

  // Adherence counts answered doses only; unanswered reminders are reported separately.
  const doses7d = (patient.doses ?? []).filter((d) => Date.parse(d.ts) >= since7d);
  const answered = doses7d.filter((d) => typeof d.taken === 'boolean');
  const adherence7d = answered.length ? answered.filter((d) => d.taken).length / answered.length : null;
  const unconfirmedDoses7d = doses7d.length - answered.length;

  const alerts = store.listAlerts().filter((a) => a.patientId === patient.id && a.status !== 'resolved');

  // RPM billing needs data on >= 16 distinct days per 30 (device readings or daily weights).
  const readingDays = new Set([
    ...store.listReadings(patient.id).filter((r) => Date.parse(r.ts) >= since30d).map((r) => dayKey(r.ts)),
    ...(patient.weights ?? []).filter((w) => Date.parse(w.ts) >= since30d).map((w) => dayKey(w.ts)),
  ]);

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
  };
}
