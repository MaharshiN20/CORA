// Readmission risk score, in two transparent, additive parts so the care team (and judges)
// can see exactly why a patient is High risk:
//
//   baseline -> simplified LACE/HOSPITAL-style factors known at discharge (age, prior
//               admissions, EF, comorbidities...). Never changes after discharge.
//   dynamic  -> how the patient is actually doing at home, from getSignals(patient):
//               missed check-ins, adherence, weight trend, open alerts, social needs,
//               self-care understanding. This is what moves a patient between tiers.
//
//   scoreRisk(patient, signals?, { previousScore? }) -> {
//     score, tier: 'Low'|'Med'|'High',
//     factors: [{ label, points }],          // baseline + dynamic, for the dashboard
//     plan: { checkinsPerDay, askSpo2, askOrthopnea },
//     baseline: { score, factors },
//     dynamic?: { score, factors, trend: 'up'|'down'|'flat' },   // only when signals given
//   }
//   recordRisk(patient, signals?) -> Promise<{ ts, patientId, score, tier } | null>   // appends to riskHistory
// History itself lives in insights/riskHistory.js: this file stays free of
// store imports because seed.js imports it while the store is still initialising.
//
// Without signals, score/tier/factors/plan are exactly the baseline (seed + tests rely on it).
// A null signal means "no data yet" and adds 0 points, never a penalty.

const BASELINE = [
  { label: 'Age ≥ 75', points: 2, test: (p) => p.age >= 75 },
  { label: 'Age 65–74', points: 1, test: (p) => p.age >= 65 && p.age < 75 },
  { label: '2+ admissions in past year', points: 3, test: (p) => p.profile?.priorAdmits12mo >= 2 },
  { label: '1 admission in past year', points: 1, test: (p) => p.profile?.priorAdmits12mo === 1 },
  // isNum: in JS `null <= 30` is true, and an unknown EF must not score as a low one.
  { label: 'Ejection fraction ≤ 30%', points: 2, test: (p) => isNum(p.profile?.ejectionFraction) && p.profile.ejectionFraction <= 30 },
  { label: 'Length of stay ≥ 5 days', points: 1, test: (p) => p.profile?.lengthOfStay >= 5 },
  { label: 'Chronic kidney disease', points: 2, test: (p) => !!p.profile?.ckd },
  { label: 'Diabetes', points: 1, test: (p) => !!p.profile?.diabetes },
  { label: 'COPD', points: 1, test: (p) => !!p.profile?.copd },
  { label: 'Lives alone', points: 1, test: (p) => !!p.profile?.livesAlone },
];

// What the check-in looks like at each tier. Higher risk = more questions + more often.
export const PLANS = {
  Low: { checkinsPerDay: 1, askSpo2: false, askOrthopnea: false },
  Med: { checkinsPerDay: 1, askSpo2: false, askOrthopnea: true },
  High: { checkinsPerDay: 2, askSpo2: true, askOrthopnea: true },
};

export const TIER_CUTOFFS = { High: 7, Med: 4 };
export const tierFor = (score) => (score >= TIER_CUTOFFS.High ? 'High' : score >= TIER_CUTOFFS.Med ? 'Med' : 'Low');

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (x) => `${Math.round(x * 100)}%`;
const SDOH_LABELS = { transportation: 'no transportation', medication_cost: "can't afford medications" };

// Each rule returns { label, points } or null. Points are deliberately small next to the
// baseline, so one bad day nudges the tier and a pattern of bad days moves it.
const DYNAMIC = [
  (s) => {
    const n = s.missedCheckins7d;
    if (!isNum(n) || n < 1) return null;
    return { label: `Missed ${plural(n, 'check-in')} this week`, points: n >= 4 ? 3 : n >= 2 ? 2 : 1 };
  },
  (s) => {
    const a = s.adherence7d;
    if (!isNum(a) || a >= 0.8) return null;
    return { label: `Medication adherence ${pct(a)} this week (under 80%)`, points: a < 0.5 ? 3 : 2 };
  },
  (s) => {
    const d = s.weightDelta7d;
    if (!isNum(d) || d < 3) return null;
    return { label: `Weight up ${d} lb this week`, points: d >= 5 ? 3 : 2 };
  },
  (s) => {
    const d = s.weightDelta24h;
    if (!isNum(d) || d < 2) return null;
    return { label: `Weight up ${d} lb in 24 hours`, points: 1 };
  },
  (s) => (s.openRedAlerts >= 1 ? { label: `${plural(s.openRedAlerts, 'open RED alert')}`, points: 3 } : null),
  (s) => {
    const other = (s.openAlerts ?? 0) - (s.openRedAlerts ?? 0);
    return other >= 1 ? { label: `${plural(other, 'other open alert')}`, points: 1 } : null;
  },
  (s) => {
    const flags = Array.isArray(s.sdohFlags) ? s.sdohFlags : [];
    if (!flags.length) return null;
    const names = flags.map((f) => SDOH_LABELS[f] ?? String(f).replace(/_/g, ' '));
    return { label: `Social needs: ${names.join(', ')}`, points: Math.min(2, flags.length) };
  },
  (s) => {
    const l = s.lessonScore;
    if (!isNum(l) || l >= 0.5) return null;
    return { label: `Low self-care understanding (lesson score ${pct(l)})`, points: 1 };
  },
];

export function dynamicFactors(signals) {
  if (!signals) return [];
  return DYNAMIC.map((rule) => rule(signals)).filter(Boolean);
}

const sum = (factors) => factors.reduce((s, f) => s + f.points, 0);

// Trend vs. the previous score: is this patient getting riskier? previousScore defaults to
// the patient's last saved riskScore; insights/riskHistory.js passes the last history row.
export function trendFor(score, previousScore) {
  if (!isNum(previousScore)) return 'flat';
  return score > previousScore ? 'up' : score < previousScore ? 'down' : 'flat';
}

export function scoreRisk(patient, signals, { previousScore = patient.riskScore } = {}) {
  const baseFactors = BASELINE.filter((f) => f.test(patient)).map(({ label, points }) => ({ label, points }));
  const baseline = { score: sum(baseFactors), factors: baseFactors };

  if (!signals) {
    const tier = tierFor(baseline.score);
    return { score: baseline.score, tier, factors: baseFactors, plan: PLANS[tier], baseline };
  }

  const dynFactors = dynamicFactors(signals);
  const dynScore = sum(dynFactors);
  const score = baseline.score + dynScore;
  const tier = tierFor(score);
  return {
    score,
    tier,
    factors: [...baseFactors, ...dynFactors],
    plan: PLANS[tier],
    baseline,
    dynamic: { score: dynScore, factors: dynFactors, trend: trendFor(score, previousScore) },
  };
}

// Entry point for the core (aireview.js calls this after every check-in, fire-and-forget).
// History needs the store, which risk.js can't import (seed.js loads it during store init),
// so load insights/riskHistory.js on first use. Resolves to the new row, or null on error.
export async function recordRisk(patient, signals) {
  try {
    const history = await import('../insights/riskHistory.js');
    return history.recordRisk(patient, signals ?? undefined);
  } catch (err) {
    console.error('[risk] recordRisk failed:', err.message);
    return null;
  }
}
