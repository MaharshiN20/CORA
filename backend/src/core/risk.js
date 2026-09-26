// Readmission risk score: a simplified, additive LACE/HOSPITAL-style model
// tuned for heart failure. Transparent on purpose so the care team (and judges)
// can see exactly why a patient is High risk.
//
//   scoreRisk(patient) -> { score, tier: 'Low'|'Med'|'High', factors: [{label, points}], plan }

const FACTORS = [
  { label: 'Age ≥ 75', points: 2, test: (p) => p.age >= 75 },
  { label: 'Age 65–74', points: 1, test: (p) => p.age >= 65 && p.age < 75 },
  { label: '2+ admissions in past year', points: 3, test: (p) => p.profile.priorAdmits12mo >= 2 },
  { label: '1 admission in past year', points: 1, test: (p) => p.profile.priorAdmits12mo === 1 },
  { label: 'Ejection fraction ≤ 30%', points: 2, test: (p) => p.profile.ejectionFraction <= 30 },
  { label: 'Length of stay ≥ 5 days', points: 1, test: (p) => p.profile.lengthOfStay >= 5 },
  { label: 'Chronic kidney disease', points: 2, test: (p) => p.profile.ckd },
  { label: 'Diabetes', points: 1, test: (p) => p.profile.diabetes },
  { label: 'COPD', points: 1, test: (p) => p.profile.copd },
  { label: 'Lives alone', points: 1, test: (p) => p.profile.livesAlone },
];

// What the check-in looks like at each tier. Higher risk = more questions + more often.
export const PLANS = {
  Low: { checkinsPerDay: 1, askSpo2: false, askOrthopnea: false },
  Med: { checkinsPerDay: 1, askSpo2: false, askOrthopnea: true },
  High: { checkinsPerDay: 2, askSpo2: true, askOrthopnea: true },
};

export function scoreRisk(patient) {
  const factors = FACTORS.filter((f) => f.test(patient)).map(({ label, points }) => ({ label, points }));
  const score = factors.reduce((s, f) => s + f.points, 0);
  const tier = score >= 7 ? 'High' : score >= 4 ? 'Med' : 'Low';
  return { score, tier, factors, plan: PLANS[tier] };
}
