// ROI calculator math, same formulas as the backend's insights/metrics.js roi() so the
// sliders respond instantly without a round trip. Sources: docs/STRATEGY.md.
export const ROI_DEFAULTS = {
  discharges: 1000,
  readmitRate: 0.205,
  costPerReadmit: 15000,
  reduction: 0.25,
  penaltyPct: 0.0069,
  medicareRevenue: 50_000_000,
  tcmContactRate: 0.8,
  tcmHighComplexityShare: 0.4,
  rpmEligibleRate: 0.6,
};
export const RATES = { tcm99495: 220, tcm99496: 298, rpm99454: 52, rpm99457: 52 };

export function roi(input = {}) {
  const p = { ...ROI_DEFAULTS };
  for (const [k, v] of Object.entries(input)) if (k in p && v !== '' && v != null && Number.isFinite(Number(v))) p[k] = Number(v);

  const readmissionsAvoided = p.discharges * p.readmitRate * p.reduction;
  const readmissionCostAvoided = readmissionsAvoided * p.costPerReadmit;
  const penaltyAvoided = p.penaltyPct * p.medicareRevenue * Math.min(1, p.reduction);
  const tcmPatients = p.discharges * p.tcmContactRate;
  const tcmRevenue = tcmPatients * (p.tcmHighComplexityShare * RATES.tcm99496 + (1 - p.tcmHighComplexityShare) * RATES.tcm99495);
  const rpmPatients = p.discharges * p.rpmEligibleRate;
  const rpmRevenue = rpmPatients * (RATES.rpm99454 + RATES.rpm99457);

  const r = Math.round;
  return {
    inputs: p,
    readmissionsAvoided: Math.round(readmissionsAvoided * 10) / 10,
    dollars: {
      readmissionCostAvoided: r(readmissionCostAvoided),
      penaltyAvoided: r(penaltyAvoided),
      tcmRevenue: r(tcmRevenue),
      rpmRevenue: r(rpmRevenue),
      total: r(readmissionCostAvoided + penaltyAvoided + tcmRevenue + rpmRevenue),
    },
  };
}
