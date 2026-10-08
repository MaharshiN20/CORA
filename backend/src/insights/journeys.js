// One normalized "journey" per patient (30 days after discharge), so every insight metric
// works the same on the synthetic cohort and on the live demo patients.
//
//   Journey = {
//     id, patientId, source: 'cohort' | 'live', language,
//     dischargedAt, days,                      // days observed (<= 30)
//     responses: [{ day, responded, recoveredVia: null | 'nudge' | 'caregiver' }],  // day 1..days
//     alerts: [{ tier, kind, status, outcome, ackMinutes, ageMinutes? }],   // ackMinutes null if never acked;
//                                              // ageMinutes = how long an unacked live alert has been open
//     readmitted: boolean | null,              // null = not known yet (live patients: false only once the
//                                              // 30-day window has passed without a readmission)
//     refillGapDays, rpmDays,
//   }
import * as store from '../store.js';
import * as clock from '../core/clock.js';

export const WINDOW_DAYS = 30;
const DAY = clock.DAY;

const dayOf = (dischargedMs, ts) => Math.floor((Date.parse(ts) - dischargedMs) / DAY) + 1;

// Minutes from alert creation to the first acknowledged/contacted/resolved step.
export function ackMinutes(alert) {
  const opened = Date.parse(alert.history?.[0]?.ts ?? alert.ts);
  const acked = (alert.history ?? []).find((h) => h.status && h.status !== 'open');
  if (!acked || !Number.isFinite(opened)) return null;
  return Math.max(0, Math.round((Date.parse(acked.ts) - opened) / 60000));
}

export function liveJourney(patient, { alerts = store.listAlerts(), audit = store.listAudit(patient.id), now = clock.now() } = {}) {
  const discharged = Date.parse(patient.dischargedAt);
  const days = Math.max(0, Math.min(WINDOW_DAYS, Math.floor((now - discharged) / DAY)));

  const answered = new Set((patient.checkins ?? []).map((c) => dayOf(discharged, c.ts)));
  const recoveries = new Map();
  for (const e of audit) {
    if (e.type !== 'outreach_recovered') continue;
    const via = e.data?.via === 'caregiver' || e.data?.afterRung >= 2 ? 'caregiver' : 'nudge';
    recoveries.set(dayOf(discharged, e.ts), via);
  }
  const responses = [];
  for (let day = 1; day <= days; day++) {
    responses.push({ day, responded: answered.has(day), recoveredVia: recoveries.get(day) ?? null });
  }

  const mine = alerts.filter((a) => a.patientId === patient.id);
  // A live patient who has not been readmitted *yet* is unknown, not a success: counting them as
  // "false" made the live rate (and the engaged-vs-not gap) depend on how long the demo had run.
  const windowClosed = now - discharged >= WINDOW_DAYS * DAY;
  const readmitted = mine.some((a) => a.outcome === 'readmitted') ? true : windowClosed ? false : null;
  const gaps = (patient.prescriptions ?? [])
    .filter((rx) => rx.expectedPickup)
    .map((rx) => {
      const end = rx.pickedUpAt ? Date.parse(rx.pickedUpAt) : now;
      return Math.max(0, Math.floor((end - Date.parse(rx.expectedPickup)) / DAY));
    });
  const since30 = now - WINDOW_DAYS * DAY;
  const rpmDays = new Set((patient.weights ?? []).filter((w) => Date.parse(w.ts) >= since30).map((w) => w.ts.slice(0, 10))).size;

  return {
    id: `live-${patient.id}`,
    patientId: patient.id,
    source: 'live',
    language: patient.language ?? 'en',
    dischargedAt: patient.dischargedAt,
    days,
    responses,
    alerts: mine.map((a) => {
      const acked = ackMinutes(a);
      return {
        tier: a.tier,
        kind: a.kind ?? 'triage',
        status: a.status,
        outcome: a.outcome ?? null,
        ackMinutes: acked,
        ...(acked == null && { ageMinutes: Math.max(0, Math.round((now - Date.parse(a.ts)) / 60000)) }),
      };
    }),
    readmitted,
    refillGapDays: gaps.length ? Math.max(...gaps) : 0,
    rpmDays,
  };
}

// Alerts and audit rows are grouped by patient once, instead of filtered per patient.
export function liveJourneys() {
  const alertsBy = new Map();
  for (const a of store.listAlerts()) (alertsBy.get(a.patientId) ?? alertsBy.set(a.patientId, []).get(a.patientId)).push(a);
  const auditBy = new Map();
  for (const e of store.listAudit()) if (e.type === 'outreach_recovered') (auditBy.get(e.patientId) ?? auditBy.set(e.patientId, []).get(e.patientId)).push(e);
  const now = clock.now();
  return store.listPatients().map((p) => liveJourney(p, { alerts: alertsBy.get(p.id) ?? [], audit: auditBy.get(p.id) ?? [], now }));
}
export const cohortJourneys = () => store.collection('cohort');

export function journeysFor(source = 'all') {
  if (source === 'cohort') return cohortJourneys();
  if (source === 'live') return liveJourneys();
  return [...cohortJourneys(), ...liveJourneys()];
}
