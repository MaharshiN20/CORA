// Demo patients. Mrs. Garcia is the "hero" patient for the pitch: high risk,
// Spanish-speaking, weight trending up, unfilled diuretic refill.
const DAY = 24 * 60 * 60 * 1000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

// weights: oldest -> newest (lb), one per day
const weightLog = (weights) =>
  weights.map((lb, i) => ({ ts: iso(weights.length - 1 - i), lb }));

const CHF_MEDS = [
  { name: 'Furosemide', dose: '40 mg', times: ['08:00'], diuretic: true },
  { name: 'Carvedilol', dose: '12.5 mg', times: ['08:00', '20:00'] },
  { name: 'Lisinopril', dose: '10 mg', times: ['08:00'] },
];

function patient(p) {
  return {
    condition: 'CHF',
    channel: 'telegram',
    chatId: null,
    checkin: { state: 'idle', answers: {} },
    vitals: [],
    doses: [],
    riskScore: null,
    riskTier: null,
    ...p,
    caregiver: { chatId: null, ...p.caregiver },
  };
}

export function buildSeed() {
  return {
    patients: [
      patient({
        id: 'p1',
        linkCode: 'GARCIA1',
        name: 'Maria Garcia',
        age: 78,
        language: 'es',
        dischargedAt: iso(6),
        profile: { priorAdmits12mo: 2, ejectionFraction: 30, lengthOfStay: 6, ckd: true, diabetes: true, copd: false, livesAlone: true },
        dryWeightLb: 172,
        weights: weightLog([172, 172.4, 173, 173.2, 174.1, 176.8]),
        meds: CHF_MEDS,
        prescriptions: [
          { med: 'Furosemide', expectedPickup: iso(5), pickedUpAt: null },
          { med: 'Carvedilol', expectedPickup: iso(5), pickedUpAt: iso(5) },
          { med: 'Lisinopril', expectedPickup: iso(5), pickedUpAt: iso(5) },
        ],
        caregiver: { name: 'Sofia Garcia', relation: 'daughter', language: 'en' },
      }),
      patient({
        id: 'p2',
        linkCode: 'JOHNSON1',
        name: 'Robert Johnson',
        age: 71,
        language: 'en',
        dischargedAt: iso(4),
        profile: { priorAdmits12mo: 1, ejectionFraction: 35, lengthOfStay: 4, ckd: false, diabetes: true, copd: true, livesAlone: false },
        dryWeightLb: 205,
        weights: weightLog([205, 205.2, 204.8, 205.5]),
        meds: CHF_MEDS,
        prescriptions: [
          { med: 'Furosemide', expectedPickup: iso(3), pickedUpAt: iso(3) },
          { med: 'Carvedilol', expectedPickup: iso(3), pickedUpAt: iso(3) },
          { med: 'Lisinopril', expectedPickup: iso(3), pickedUpAt: iso(3) },
        ],
        caregiver: { name: 'Linda Johnson', relation: 'wife', language: 'en' },
      }),
      patient({
        id: 'p3',
        linkCode: 'NGUYEN1',
        name: 'Thanh Nguyen',
        age: 66,
        language: 'vi',
        dischargedAt: iso(9),
        profile: { priorAdmits12mo: 0, ejectionFraction: 40, lengthOfStay: 3, ckd: false, diabetes: false, copd: false, livesAlone: false },
        dryWeightLb: 150,
        weights: weightLog([150, 150.4, 149.8, 150.1, 150, 149.6, 150.2]),
        meds: CHF_MEDS,
        prescriptions: [{ med: 'Furosemide', expectedPickup: iso(8), pickedUpAt: iso(8) }],
        caregiver: { name: 'Minh Nguyen', relation: 'son', language: 'en' },
      }),
      patient({
        id: 'p4',
        linkCode: 'PATEL1',
        name: 'Anil Patel',
        age: 83,
        language: 'hi',
        dischargedAt: iso(2),
        profile: { priorAdmits12mo: 3, ejectionFraction: 25, lengthOfStay: 8, ckd: true, diabetes: true, copd: false, livesAlone: false },
        dryWeightLb: 160,
        weights: weightLog([160, 161.2]),
        meds: CHF_MEDS,
        prescriptions: [
          { med: 'Furosemide', expectedPickup: iso(1), pickedUpAt: null },
          { med: 'Carvedilol', expectedPickup: iso(1), pickedUpAt: null },
        ],
        caregiver: { name: 'Priya Patel', relation: 'granddaughter', language: 'en' },
      }),
      patient({
        id: 'p5',
        linkCode: 'SMITH1',
        name: 'Dorothy Smith',
        age: 59,
        language: 'en',
        dischargedAt: iso(12),
        profile: { priorAdmits12mo: 0, ejectionFraction: 45, lengthOfStay: 2, ckd: false, diabetes: false, copd: false, livesAlone: true },
        dryWeightLb: 140,
        weights: weightLog([140, 139.6, 140.2, 139.8, 140, 139.5, 139.9]),
        meds: CHF_MEDS,
        prescriptions: [{ med: 'Furosemide', expectedPickup: iso(11), pickedUpAt: iso(11) }],
        caregiver: { name: 'James Smith', relation: 'brother', language: 'en' },
      }),
    ],
    messages: [],
    alerts: [],
    demoDayOffset: 0,
  };
}

// `npm run seed` -> wipe data/db.json back to the seed
if (process.argv.includes('--reset')) {
  const { reset } = await import('./store.js');
  reset();
  console.log('Seed data restored to data/db.json');
}
