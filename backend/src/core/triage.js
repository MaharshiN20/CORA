// ============================================================================
// Triage rule engine. PURE and deterministic: no I/O, no LLM, no clock reads.
// Every decision can be traced to a rule below.
//
// Thresholds follow standard heart-failure self-management guidance
// (AHA/HFSA patient education: call if +2-3 lb in a day or +5 lb in a week).
//
//   triage({ weights, answers, missedDiureticDays }) -> {
//     tier: 'GREEN' | 'YELLOW' | 'RED',
//     flags:  [{ code, tier, text }],   // why (English, for the care team)
//     advice: [code],                   // self-care tips to send the patient
//     priority: number                  // sort key for the nurse queue
//   }
//
// Inputs
//   weights: [{ ts, lb }]  oldest -> newest; the last entry is "today"
//   answers: {
//     breath:    'normal' | 'exertion' | 'rest'
//     orthopnea: boolean   (needs more pillows / wakes up breathless)
//     swelling:  'none' | 'mild' | 'worse'
//     chestPain, confusion, fainting, dizzy: boolean
//     spo2:      number (%), optional
//     heartRate: number (bpm), optional
//   }
//   missedDiureticDays: consecutive days the diuretic was missed (0 = taken)
// ============================================================================

import { localDayKey } from './planning.js';

export const TIERS = ['GREEN', 'YELLOW', 'RED'];
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const THRESHOLDS = {
  gain24hLb: 2,
  gain7dLb: 5,
  lossDehydrationLb: 3,
  spo2Red: 90, // < 90 -> RED
  spo2Yellow: 93, // 90-92 -> YELLOW
  hrHigh: 120,
  hrLow: 50,
  missedDiureticDays: 2,
};

// ---------- weight trend helpers ----------

// Change vs. the most recent prior reading taken 12-48h before the latest.
export function weightChange24h(weights) {
  const latest = weights.at(-1);
  if (!latest) return null;
  const t = Date.parse(latest.ts);
  for (let i = weights.length - 2; i >= 0; i--) {
    const age = t - Date.parse(weights[i].ts);
    if (age >= 12 * HOUR && age <= 48 * HOUR) return round1(latest.lb - weights[i].lb);
    if (age > 48 * HOUR) break;
  }
  return null;
}

// Change vs. the oldest reading within the last 7 days (window widened to 7.5
// days so small timing drift in daily check-ins doesn't drop the baseline).
export function weightChange7d(weights) {
  const latest = weights.at(-1);
  if (!latest) return null;
  const t = Date.parse(latest.ts);
  const inWindow = weights.filter((w) => {
    const age = t - Date.parse(w.ts);
    return age > 0 && age <= 7.5 * DAY;
  });
  if (!inWindow.length) return null;
  return round1(latest.lb - inWindow[0].lb);
}

const round1 = (n) => Math.round(n * 10) / 10;

// ---------- main ----------

export function triage({ weights = [], answers = {}, missedDiureticDays = 0 } = {}) {
  const flags = [];
  const advice = new Set();
  const flag = (tier, code, text) => flags.push({ tier, code, text });

  const d24 = weightChange24h(weights);
  const d7 = weightChange7d(weights);
  const { breath, orthopnea, swelling, chestPain, confusion, fainting, dizzy, spo2, heartRate } = answers;

  // ---- RED: emergency, patient told to call 911 ----
  if (chestPain) flag('RED', 'chest_pain', 'Chest pain or pressure');
  if (breath === 'rest') flag('RED', 'sob_rest', 'Short of breath at rest');
  if (confusion) flag('RED', 'confusion', 'New confusion');
  if (fainting) flag('RED', 'syncope', 'Fainted / passed out');
  if (isNum(spo2) && spo2 < THRESHOLDS.spo2Red) flag('RED', 'spo2_low', `SpO2 ${spo2}% (< ${THRESHOLDS.spo2Red}%)`);

  // ---- YELLOW: nurse callback today ----
  if (isNum(d24) && d24 >= THRESHOLDS.gain24hLb)
    flag('YELLOW', 'weight_24h', `Weight up ${d24} lb in 24h (≥ ${THRESHOLDS.gain24hLb})`);
  if (isNum(d7) && d7 >= THRESHOLDS.gain7dLb)
    flag('YELLOW', 'weight_7d', `Weight up ${d7} lb in 7 days (≥ ${THRESHOLDS.gain7dLb})`);
  if (orthopnea) flag('YELLOW', 'orthopnea', 'Needs more pillows / wakes up breathless');
  if (swelling === 'worse') flag('YELLOW', 'edema_worse', 'Leg/ankle swelling getting worse');
  if (missedDiureticDays >= THRESHOLDS.missedDiureticDays)
    flag('YELLOW', 'missed_diuretic', `Missed diuretic ${missedDiureticDays} days in a row`);
  if (isNum(spo2) && spo2 >= THRESHOLDS.spo2Red && spo2 < THRESHOLDS.spo2Yellow)
    flag('YELLOW', 'spo2_borderline', `SpO2 ${spo2}% (borderline)`);
  if (isNum(heartRate) && (heartRate > THRESHOLDS.hrHigh || heartRate < THRESHOLDS.hrLow))
    flag('YELLOW', 'hr_abnormal', `Heart rate ${heartRate} bpm`);

  // Judgment rules: a symptom that is mild alone but concerning in context.
  const fluidSigns = flags.some((f) => ['weight_24h', 'weight_7d', 'edema_worse', 'orthopnea'].includes(f.code));
  if (breath === 'exertion') {
    if (fluidSigns) flag('YELLOW', 'sob_exertion_fluid', 'More breathless with activity + signs of fluid build-up');
    else advice.add('pace_activity');
  }
  if (dizzy) {
    // Dizziness + weight dropping fast suggests over-diuresis / low blood pressure.
    if (isNum(d24) && d24 <= -THRESHOLDS.lossDehydrationLb)
      flag('YELLOW', 'dizzy_dehydration', `Dizzy with weight down ${Math.abs(d24)} lb in 24h (possible over-diuresis)`);
    else advice.add('stand_slowly');
  }

  // ---- GREEN self-care advice ----
  if (swelling === 'mild') advice.add('elevate_legs').add('low_sodium');
  if (isNum(d24) && d24 >= 1 && d24 < THRESHOLDS.gain24hLb) advice.add('low_sodium').add('watch_fluids');
  if (missedDiureticDays === 1) advice.add('missed_dose');
  if (fluidSigns) advice.add('low_sodium');

  const tier = flags.some((f) => f.tier === 'RED') ? 'RED' : flags.length ? 'YELLOW' : 'GREEN';
  // Higher = more urgent. RED always outranks YELLOW; more flags rank higher within a tier.
  const priority = TIERS.indexOf(tier) * 100 + flags.length;
  if (tier === 'GREEN' && advice.size === 0) advice.add('doing_great');

  return { tier, flags, advice: [...advice], priority, weight: { change24h: d24, change7d: d7 } };
}

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

// Consecutive most-recent days a diuretic dose was missed.
// doses: [{ ts, med, taken: boolean, diuretic?: boolean }]
// Unanswered doses (taken === null) are ignored: silence is not a missed dose.
// Days are local calendar days (a 9pm check-in belongs to today, not UTC tomorrow).
export function consecutiveMissedDiureticDays(doses = []) {
  const byDay = new Map();
  for (const d of doses.filter((x) => x.diuretic && typeof x.taken === 'boolean')) {
    const day = localDayKey(Date.parse(d.ts));
    byDay.set(day, (byDay.get(day) ?? false) || d.taken);
  }
  const days = [...byDay.keys()].sort().reverse();
  let n = 0;
  for (const day of days) {
    if (byDay.get(day)) break;
    n++;
  }
  return n;
}
