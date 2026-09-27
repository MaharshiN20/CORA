// Risk over time: one row per scoring, so the dashboard can chart a patient's trajectory
// and the trend arrow means "since last time", not "since discharge".
//
//   recordRisk(patient, signals?) -> { ts, patientId, score, tier }
//     Scores with getSignals(patient) (unless signals are given), compares against the
//     patient's last row for the trend, appends to store.collection('riskHistory').
//     The core calls it after each check-in.
//   riskHistory(patientId) -> rows oldest -> newest
//   lastRisk(patientId)    -> newest row | null
import * as store from '../store.js';
import * as clock from '../core/clock.js';
import { getSignals } from '../core/signals.js';
import { scoreRisk } from '../core/risk.js';

const rows = () => store.collection('riskHistory');

export const riskHistory = (patientId) =>
  rows()
    .filter((r) => r.patientId === patientId)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

export const lastRisk = (patientId) => riskHistory(patientId).at(-1) ?? null;

// Score now, with the trend measured against this patient's previous history row.
export function currentRisk(patient, signals = getSignals(patient)) {
  return scoreRisk(patient, signals, { previousScore: lastRisk(patient.id)?.score ?? patient.riskScore });
}

export function recordRisk(patient, signals = getSignals(patient)) {
  const { score, tier } = currentRisk(patient, signals);
  const row = { ts: clock.nowISO(), patientId: patient.id, score, tier };
  rows().push(row);
  store.persist('update', null);
  return row;
}
