// Impact metrics over journeys (see journeys.js). Pure: arrays in, numbers out, so each
// metric is tested on small hand-built data with exact answers. Rates are 0..1 and
// rounded to 3 decimals; anything with no data is null (never a misleading 0).
import { WINDOW_DAYS } from './journeys.js';
import { SLA_MS } from '../store.js';

export const ENGAGED_THRESHOLD = 0.6; // answered >= 60% of days = engaged
const POSITIVE = new Set(['true_positive', 'ed_avoided', 'readmitted']); // the alert was real

const r3 = (x) => Math.round(x * 1000) / 1000;
const rate = (num, den) => (den ? r3(num / den) : null);

export function median(xs) {
  const s = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export const responseRate = (j) => rate(j.responses.filter((r) => r.responded).length, j.responses.length);
export const isEngaged = (j) => (responseRate(j) ?? 0) >= ENGAGED_THRESHOLD;

// Below this many known outcomes a readmission rate is a handful of patients, not a rate.
export const MIN_KNOWN_OUTCOMES = 10;

function readmission(js) {
  const known = js.filter((j) => typeof j.readmitted === 'boolean');
  return { n: known.length, readmitted: known.filter((j) => j.readmitted).length, rate: rate(known.filter((j) => j.readmitted).length, known.length) };
}

const allAlerts = (js) => js.flatMap((j) => j.alerts ?? []);

function alertPrecision(alerts) {
  const judged = alerts.filter((a) => a.status === 'resolved' && a.outcome);
  return rate(judged.filter((a) => POSITIVE.has(a.outcome)).length, judged.length);
}

// ---------------------------------------------------------------------------
// GET /impact
export const SLA_MINUTES = Object.fromEntries(Object.entries(SLA_MS).map(([tier, ms]) => [tier, ms / 60000])); // the store's SLAs
export function impact(js, { nurses = 2, windowDays = WINDOW_DAYS } = {}) {
  const engaged = readmission(js.filter(isEngaged));
  const notEngaged = readmission(js.filter((j) => !isEngaged(j)));
  // Counterfactual: engaged patients would have readmitted at the not-engaged rate.
  const avoided =
    engaged.rate != null && notEngaged.rate != null ? Math.max(0, r3((notEngaged.rate - engaged.rate) * engaged.n)) : null;
  const alerts = allAlerts(js);
  const overall = readmission(js);
  // INFO items (refills, social needs, questions) are tasks, not alerts a nurse races to; load is the
  // rest, over the days the journeys actually cover (a 3-day-old live patient is not 30 days of data).
  const actionable = alerts.filter((a) => a.tier !== 'INFO');
  const observedDays = Math.min(windowDays, Math.max(1, ...js.map((j) => (Number.isFinite(j.days) ? j.days : windowDays))));
  // An open alert still inside its SLA window has not missed anything yet: leave it out of the
  // "within SLA" share until it is acknowledged or overdue.
  const pending = (a) => a.ackMinutes == null && Number.isFinite(a.ageMinutes) && a.ageMinutes <= (SLA_MINUTES[a.tier] ?? Infinity);
  return {
    patients: js.length,
    engagedShare: rate(js.filter(isEngaged).length, js.length),
    readmission: { engaged, notEngaged, overall },
    sampleIsSmall: overall.n < MIN_KNOWN_OUTCOMES,
    projectedReadmissionsAvoided: avoided,
    // 'synthetic': the cohort is generated with the engaged/not-engaged gap built in, so this is an
    // assumption, not a finding. 'observed': live patients only.
    projectedBasis: !js.length ? null : js.some((j) => j.source === 'cohort') ? 'synthetic' : 'observed',
    alerts: {
      total: alerts.length,
      actionable: actionable.length,
      pendingWithinSla: alerts.filter(pending).length,
      perNursePerDay: js.length ? r3(actionable.length / (Math.max(1, nurses) * observedDays)) : null,
      medianMinutesToAck: median(alerts.map((a) => a.ackMinutes)),
      medianMinutesToAckByTier: Object.fromEntries(
        ['RED', 'YELLOW', 'INFO'].map((t) => [t, median(alerts.filter((a) => a.tier === t).map((a) => a.ackMinutes))]),
      ),
      // Share acknowledged within the tier's SLA (never acknowledged = missed). A median in
      // minutes hides RED's 14 min next to INFO's 9 h; a percentage reads the same for all.
      withinSlaByTier: Object.fromEntries(
        Object.entries(SLA_MINUTES).map(([t, m]) => {
          const mine = alerts.filter((a) => a.tier === t && !pending(a));
          return [t, rate(mine.filter((a) => a.ackMinutes != null && a.ackMinutes <= m).length, mine.length)];
        }),
      ),
      precision: alertPrecision(alerts),
    },
    assumptions: { nurses, windowDays, engagedThreshold: ENGAGED_THRESHOLD, positiveOutcomes: [...POSITIVE] },
  };
}

// ---------------------------------------------------------------------------
// GET /engagement
export function engagement(js, { windowDays = WINDOW_DAYS } = {}) {
  const byDay = [];
  for (let day = 1; day <= windowDays; day++) {
    const eligible = js.filter((j) => j.responses.some((r) => r.day === day));
    const answered = eligible.filter((j) => j.responses.find((r) => r.day === day).responded);
    // Still engaged = answers on this day or any later day (retention / drop-off curve).
    const retained = eligible.filter((j) => j.responses.some((r) => r.day >= day && r.responded));
    if (!eligible.length) continue;
    byDay.push({ day, eligible: eligible.length, responseRate: rate(answered.length, eligible.length), retention: rate(retained.length, eligible.length) });
  }
  const recoveries = js.flatMap((j) => j.responses.filter((r) => r.recoveredVia).map((r) => ({ id: j.id, via: r.recoveredVia })));
  const responses = js.flatMap((j) => j.responses);
  return {
    patients: js.length,
    overallResponseRate: rate(responses.filter((r) => r.responded).length, responses.length),
    byDay,
    ladder: {
      recoveries: recoveries.length,
      viaNudge: recoveries.filter((r) => r.via === 'nudge').length,
      viaCaregiver: recoveries.filter((r) => r.via === 'caregiver').length,
      patientsRecovered: new Set(recoveries.map((r) => r.id)).size,
    },
  };
}

// ---------------------------------------------------------------------------
// GET /equity
export function equity(js) {
  const langs = [...new Set(js.map((j) => j.language))].sort();
  const row = (group) => {
    const responses = group.flatMap((j) => j.responses);
    const alerts = allAlerts(group);
    return {
      patients: group.length,
      responseRate: rate(responses.filter((r) => r.responded).length, responses.length),
      engagedShare: rate(group.filter(isEngaged).length, group.length),
      readmissionRate: readmission(group).rate,
      alertsPerPatient: rate(alerts.length, group.length),
      medianMinutesToAck: median(alerts.map((a) => a.ackMinutes)),
    };
  };
  const byLanguage = Object.fromEntries(langs.map((l) => [l, row(js.filter((j) => j.language === l))]));
  const english = byLanguage.en?.responseRate;
  const nonEnglish = row(js.filter((j) => j.language !== 'en'));
  return {
    byLanguage,
    english: byLanguage.en ?? null,
    nonEnglish,
    // Positive = non-English patients answer less often than English ones.
    responseGap: english != null && nonEnglish.responseRate != null ? r3(english - nonEnglish.responseRate) : null,
  };
}

// ---------------------------------------------------------------------------
// GET /roi: dollars. Defaults and sources in docs/STRATEGY.md.
export const ROI_DEFAULTS = {
  discharges: 1000, // HF discharges per year at the hospital
  readmitRate: 0.205, // 30-day HF readmission (JACC: HF HRRP paper)
  costPerReadmit: 15000, // typical cost of one HF readmission
  reduction: 0.25, // relative readmission reduction from the program
  penaltyPct: 0.0069, // median FY2026 HRRP penalty (share of Medicare inpatient pay)
  medicareRevenue: 50_000_000, // Medicare inpatient revenue at risk
  tcmContactRate: 0.8, // share reached within 2 business days (TCM eligible)
  tcmHighComplexityShare: 0.4, // 99496 vs 99495 mix
  rpmEligibleRate: 0.6, // share with >= 16 reading-days in 30 (RPM eligible)
};
export const RATES = { tcm99495: 220, tcm99496: 298, rpm99454: 52, rpm99457: 52 };

// Sensible bounds for each input. A negative cost or a 300% rate produces nonsense dollars, so
// out-of-range values are pulled to the nearest bound and reported in `clamped`.
const ROI_BOUNDS = {
  discharges: [0, 1e6],
  readmitRate: [0, 1],
  costPerReadmit: [0, 1e6],
  reduction: [0, 1],
  penaltyPct: [0, 1],
  medicareRevenue: [0, 1e11],
  tcmContactRate: [0, 1],
  tcmHighComplexityShare: [0, 1],
  rpmEligibleRate: [0, 1],
};

export function roi(params = {}) {
  const p = { ...ROI_DEFAULTS };
  const clamped = [];
  for (const [k, v] of Object.entries(params)) {
    if (!(k in p) || v === '' || v == null || !Number.isFinite(Number(v))) continue;
    const [lo, hi] = ROI_BOUNDS[k];
    p[k] = Math.min(hi, Math.max(lo, Number(v)));
    if (p[k] !== Number(v)) clamped.push(k);
  }

  const baselineReadmissions = p.discharges * p.readmitRate;
  const readmissionsAvoided = baselineReadmissions * p.reduction;
  const readmissionCostAvoided = readmissionsAvoided * p.costPerReadmit;
  // HRRP penalties scale with excess readmissions, so assume the penalty shrinks in
  // proportion to the reduction (capped at the whole penalty).
  const penaltyAtRisk = p.penaltyPct * p.medicareRevenue;
  const penaltyAvoided = penaltyAtRisk * Math.min(1, p.reduction);
  const tcmPatients = p.discharges * p.tcmContactRate;
  const tcmRevenue = tcmPatients * (p.tcmHighComplexityShare * RATES.tcm99496 + (1 - p.tcmHighComplexityShare) * RATES.tcm99495);
  const rpmPatients = p.discharges * p.rpmEligibleRate;
  const rpmRevenue = rpmPatients * (RATES.rpm99454 + RATES.rpm99457); // one month each, one 20-min unit

  const round = (n) => Math.round(n);
  return {
    inputs: p,
    readmissions: { baseline: r3(baselineReadmissions), avoided: r3(readmissionsAvoided) },
    dollars: {
      readmissionCostAvoided: round(readmissionCostAvoided),
      penaltyAvoided: round(penaltyAvoided),
      tcmRevenue: round(tcmRevenue),
      rpmRevenue: round(rpmRevenue),
      total: round(readmissionCostAvoided + penaltyAvoided + tcmRevenue + rpmRevenue),
    },
    eligible: { tcmPatients: round(tcmPatients), rpmPatients: round(rpmPatients) },
    rates: RATES,
    clamped,
  };
}

// Measured rates from journeys, used to prefill the ROI calculator.
export function measuredRates(js) {
  return {
    tcmContactRate: rate(js.filter((j) => j.responses.slice(0, 2).some((r) => r.responded)).length, js.length),
    rpmEligibleRate: rate(js.filter((j) => j.rpmDays >= 16).length, js.length),
  };
}
