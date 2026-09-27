import { scoreRisk } from './core/risk.js';
import * as clock from './core/clock.js';
import { triage } from './core/triage.js';
import { atLocalTime } from './core/planning.js';

// Demo patients. Mrs. Garcia is the "hero" patient for the pitch: high risk,
// Spanish-speaking, weight trending up, unfilled diuretic refill.
const DAY = 24 * 60 * 60 * 1000;
// Relative to the demo clock so clones made after a fast-forward (judge mode) stay current.
const iso = (daysAgo) => new Date(clock.now() - daysAgo * DAY).toISOString();

// weights: oldest -> newest (lb), one per day
const weightLog = (weights) =>
  weights.map((lb, i) => ({ ts: iso(weights.length - 1 - i), lb }));

// Guideline-style regimens (synthetic), different per patient so the dashboard reads like
// real people: loop diuretic + beta-blocker + RAS agent, plus comorbidity meds.
const CHF_MEDS = [
  { name: 'Furosemide', dose: '40 mg', times: ['08:00'], diuretic: true },
  { name: 'Carvedilol', dose: '12.5 mg', times: ['08:00', '20:00'] },
  { name: 'Lisinopril', dose: '10 mg', times: ['08:00'] },
];
const MEDS = {
  p1: [...CHF_MEDS, { name: 'Metformin', dose: '500 mg', times: ['08:00', '20:00'] }],
  p2: [
    { name: 'Torsemide', dose: '20 mg', times: ['08:00'], diuretic: true },
    { name: 'Metoprolol succinate', dose: '50 mg', times: ['08:00'] },
    { name: 'Entresto', dose: '49/51 mg', times: ['08:00', '20:00'] },
    { name: 'Tiotropium inhaler', dose: '18 mcg', times: ['08:00'] },
  ],
  p3: [
    { name: 'Furosemide', dose: '20 mg', times: ['08:00'], diuretic: true },
    { name: 'Carvedilol', dose: '6.25 mg', times: ['08:00', '20:00'] },
    { name: 'Losartan', dose: '25 mg', times: ['08:00'] },
  ],
  p4: [
    { name: 'Bumetanide', dose: '1 mg', times: ['08:00'], diuretic: true },
    { name: 'Carvedilol', dose: '3.125 mg', times: ['08:00', '20:00'] },
    { name: 'Spironolactone', dose: '12.5 mg', times: ['08:00'] },
  ],
  p5: CHF_MEDS,
};

// Dose history for every seeded check-in day (answered, like a patient using the reminders),
// so the adherence grid and adherence7d start realistic. missed: { [med]: [daysAgo...] }.
function doseHistory(p, missed = {}) {
  const days = p.weights.slice(0, -1).map((w) => w.ts);
  return days.flatMap((ts, i) =>
    p.meds.flatMap((m) =>
      m.times.map((time) => {
        const at = new Date(atLocalTime(Date.parse(ts), time)).toISOString();
        const daysAgo = days.length - i;
        const taken = !(missed[m.name] ?? []).includes(daysAgo);
        return { id: `seed-${p.id}-${i}-${m.name}-${time}`.replace(/\W+/g, '-'), reminderId: `seed-${p.id}-${i}-${time}`, ts: at, med: m.name, dose: m.dose, diuretic: !!m.diuretic, taken, source: 'seed', respondedAt: at };
      }),
    ),
  );
}

// Fills defaults + computes baseline risk. Exported for core/enroll.js (new patients, demo clones).
export function makePatient(p) {
  const out = {
    condition: 'CHF',
    source: 'seed',
    channel: 'telegram',
    chatId: null,
    checkin: { state: 'idle', answers: {} },
    vitals: [],
    doses: [],
    riskScore: null,
    riskTier: null,
    checkins: [],
    lastTier: null,
    voiceMode: false,
    caregiverConsent: true,
    dischargeInstructions: null, // optional free text from the hospital; the companion also builds personalised ones
    // Per-patient care plan the discharge instructions are generated from (clinician-editable).
    carePlan: { fluidLimitL: 2, sodiumMg: 2000 },
    followUp: { with: 'your heart clinic', at: new Date(Date.parse(p.dischargedAt ?? clock.nowISO()) + 7 * DAY).toISOString() },
    ...p, // caller values win over every default above
    caregiver: { chatId: null, ...p.caregiver },
  };
  const risk = scoreRisk(out);
  return { ...out, riskScore: risk.score, riskTier: risk.tier, riskFactors: risk.factors };
}

// Seed patients answered a check-in on every day they have a weight, except today (today's
// check-in is the demo). Each day's tier is what triage says for the weights up to that day,
// so the history is consistent and signals don't report days of "missed" check-ins.
function withCheckinHistory(p) {
  const checkins = p.weights.slice(0, -1).map((w, i) => {
    const r = triage({ weights: p.weights.slice(0, i + 1), answers: { breath: 'normal', swelling: 'none' } });
    return { ts: w.ts, answers: { weightLb: w.lb, breath: 'normal', swelling: 'none' }, tier: r.tier, flags: r.flags, weight: r.weight, reporter: 'patient', seeded: true };
  });
  const last = checkins.at(-1);
  return { ...p, checkins, lastTier: last?.tier ?? null, lastCheckinAt: last?.ts ?? null };
}

export function buildSeed() {
  return {
    patients: [
      makePatient({
        id: 'p1',
        linkCode: 'GARCIA1',
        name: 'Maria Garcia',
        age: 78,
        language: 'es',
        dischargedAt: iso(6),
        profile: { priorAdmits12mo: 2, ejectionFraction: 30, lengthOfStay: 6, ckd: true, diabetes: true, copd: false, livesAlone: true },
        dryWeightLb: 172,
        weights: weightLog([172, 172.4, 173, 173.2, 174.1, 176.8]),
        meds: MEDS.p1,
        contactPhone: '(404) 555-0101',
        labs: { potassium: 4.6, creatinine: 1.4, at: iso(6), source: 'discharge BMP' },
        prescriptions: [
          { med: 'Furosemide', expectedPickup: iso(5), pickedUpAt: null },
          { med: 'Carvedilol', expectedPickup: iso(5), pickedUpAt: iso(5) },
          { med: 'Lisinopril', expectedPickup: iso(5), pickedUpAt: iso(5) },
        ],
        caregiver: { name: 'Sofia Garcia', relation: 'daughter', language: 'en' },
        carePlan: { fluidLimitL: 1.5, sodiumMg: 2000 },
        followUp: { with: 'Dr. Rivera (cardiology)', at: iso(-2) },
      }),
      makePatient({
        id: 'p2',
        linkCode: 'JOHNSON1',
        name: 'Robert Johnson',
        age: 71,
        language: 'en',
        dischargedAt: iso(4),
        profile: { priorAdmits12mo: 1, ejectionFraction: 35, lengthOfStay: 4, ckd: false, diabetes: true, copd: true, livesAlone: false },
        dryWeightLb: 205,
        weights: weightLog([205, 205.2, 204.8, 205.5]),
        meds: MEDS.p2,
        contactPhone: '(404) 555-0102',
        labs: { potassium: 4.1, creatinine: 1.0, at: iso(4), source: 'discharge BMP' },
        prescriptions: [
          { med: 'Torsemide', expectedPickup: iso(3), pickedUpAt: iso(3) },
          { med: 'Metoprolol succinate', expectedPickup: iso(3), pickedUpAt: iso(3) },
          { med: 'Entresto', expectedPickup: iso(3), pickedUpAt: iso(3) },
        ],
        caregiver: { name: 'Linda Johnson', relation: 'wife', language: 'en' },
      }),
      makePatient({
        id: 'p3',
        linkCode: 'NGUYEN1',
        name: 'Thanh Nguyen',
        age: 66,
        language: 'vi',
        dischargedAt: iso(9),
        profile: { priorAdmits12mo: 0, ejectionFraction: 40, lengthOfStay: 3, ckd: false, diabetes: false, copd: false, livesAlone: false },
        dryWeightLb: 150,
        weights: weightLog([150.3, 149.9, 150, 150.4, 149.8, 150.1, 150, 149.6, 150.2]),
        meds: MEDS.p3,
        contactPhone: '(678) 555-0103',
        labs: { potassium: 4.3, creatinine: 0.9, at: iso(9), source: 'discharge BMP' },
        prescriptions: [{ med: 'Furosemide', expectedPickup: iso(8), pickedUpAt: iso(8) }],
        caregiver: { name: 'Minh Nguyen', relation: 'son', language: 'en' },
      }),
      makePatient({
        id: 'p4',
        linkCode: 'PATEL1',
        name: 'Anil Patel',
        age: 83,
        language: 'hi',
        dischargedAt: iso(2),
        profile: { priorAdmits12mo: 3, ejectionFraction: 25, lengthOfStay: 8, ckd: true, diabetes: true, copd: false, livesAlone: false },
        dryWeightLb: 160,
        weights: weightLog([160, 161.2]),
        meds: MEDS.p4,
        contactPhone: '(770) 555-0104',
        labs: { potassium: 5.3, creatinine: 1.9, at: iso(2), source: 'discharge BMP' },
        prescriptions: [
          { med: 'Bumetanide', expectedPickup: iso(1), pickedUpAt: null },
          { med: 'Carvedilol', expectedPickup: iso(1), pickedUpAt: null },
        ],
        caregiver: { name: 'Priya Patel', relation: 'granddaughter', language: 'en' },
      }),
      makePatient({
        id: 'p5',
        linkCode: 'SMITH1',
        name: 'Dorothy Smith',
        age: 59,
        language: 'en',
        dischargedAt: iso(12),
        profile: { priorAdmits12mo: 0, ejectionFraction: 45, lengthOfStay: 2, ckd: false, diabetes: false, copd: false, livesAlone: true },
        dryWeightLb: 140,
        weights: weightLog([140.2, 140, 139.8, 140.1, 139.7, 140, 139.6, 140.2, 139.8, 140, 139.5, 139.9]),
        meds: MEDS.p5,
        contactPhone: '(404) 555-0105',
        labs: { potassium: 4.0, creatinine: 0.8, at: iso(12), source: 'discharge BMP' },
        prescriptions: [{ med: 'Furosemide', expectedPickup: iso(11), pickedUpAt: iso(11) }],
        caregiver: { name: 'James Smith', relation: 'brother', language: 'en' },
      }),
    ]
      .map(withCheckinHistory)
      // Maria ran out of furosemide 2 days ago (her refill is still at the pharmacy): the
      // unfilled prescription, the missed doses and the weight trend tell one story.
      .map((p) => ({ ...p, doses: doseHistory(p, p.id === 'p1' ? { Furosemide: [1, 2] } : {}) })),
    messages: [],
    alerts: [],
    demoDayOffset: 0,
  };
}
