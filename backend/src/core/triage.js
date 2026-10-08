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
//     orthopnea: boolean   (needs more pillows / sleeps propped up)
//     pnd:       boolean   (woke up at night short of breath)
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
  gain72hLb: 3, // over a skipped day (readings 48-72 h apart) the bar is a little higher
  aboveDryWeightLb: 5, // slow creep that never trips the day-to-day rules
  weightDropLb: 5, // in 24 h, on its own: over-diuresis, or a bad scale reading to double-check
  spo2Red: 90, // < 90 -> RED
  spo2Yellow: 93, // 90-92 -> YELLOW
  spo2RedCopd: 88, // COPD patients live at 88-92%: < 88 -> RED
  spo2YellowCopd: 90, // 88-89 -> YELLOW
  sbpCritical: 80, // < 80 -> RED
  sbpLow: 90, // 80-89 -> YELLOW
  sbpHigh: 180,
  dbpHigh: 110,
  hrHigh: 120,
  hrLow: 50,
  missedDiureticDays: 2,
};

// Nurse-facing reasons for answers.otherEmergency codes.
const OTHER_EMERGENCY_TEXT = {
  frothy_sputum: 'Coughing up pink or frothy sputum (possible pulmonary edema)',
  coughing_blood: 'Coughing up or vomiting blood',
  blue_lips: 'Blue or purple lips / fingertips',
  stroke_signs: 'Possible stroke: slurred speech, facial droop or one-sided weakness',
  arm_jaw_pain: 'Left arm or jaw pain / numbness (possible cardiac)',
};

// Oxygen cut-offs by patient: { red, yellow } (SpO2 below red = 911; below yellow = nurse today).
export const spo2Thresholds = (copd = false) =>
  copd ? { red: THRESHOLDS.spo2RedCopd, yellow: THRESHOLDS.spo2YellowCopd } : { red: THRESHOLDS.spo2Red, yellow: THRESHOLDS.spo2Yellow };

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

// Change vs. the prior reading 48-72 h before the latest: the "nobody weighed in yesterday" case
// that weightChange24h can't see. null when there is a reading 12-48 h back (that one is used).
export function weightChangeSkippedDay(weights) {
  const latest = weights.at(-1);
  if (!latest || weightChange24h(weights) != null) return null;
  const t = Date.parse(latest.ts);
  for (let i = weights.length - 2; i >= 0; i--) {
    const age = t - Date.parse(weights[i].ts);
    if (age > 72 * HOUR) break;
    if (age > 48 * HOUR) return { delta: round1(latest.lb - weights[i].lb), days: Math.round(age / DAY) };
  }
  return null;
}

const round1 = (n) => Math.round(n * 10) / 10;

// ---------- main ----------

// dryWeightLb: the patient's target weight (optional). copd: widens the oxygen cut-offs.
// bp: a reported { sbp, dbp } (optional).
export function triage({ weights = [], answers = {}, missedDiureticDays = 0, dryWeightLb = null, copd = false, bp = null } = {}) {
  const flags = [];
  const advice = new Set();
  const flag = (tier, code, text) => flags.push({ tier, code, text });

  const d24 = weightChange24h(weights);
  const d7 = weightChange7d(weights);
  const skipped = weightChangeSkippedDay(weights);
  const o2 = spo2Thresholds(copd);
  const { breath, orthopnea, pnd, swelling, chestPain, confusion, fainting, dizzy, spo2, heartRate, otherEmergency } = answers;

  // ---- RED: emergency, patient told to call 911 ----
  if (chestPain) flag('RED', 'chest_pain', 'Chest pain or pressure');
  if (breath === 'rest') flag('RED', 'sob_rest', 'Short of breath at rest');
  if (confusion) flag('RED', 'confusion', 'New confusion');
  if (fainting) flag('RED', 'syncope', 'Fainted / passed out');
  if (isNum(spo2) && spo2 < o2.red) flag('RED', 'spo2_low', `SpO2 ${spo2}% (< ${o2.red}%${copd ? ', COPD' : ''})`);
  if (isBp(bp) && bp.sbp < THRESHOLDS.sbpCritical) flag('RED', 'bp_critical', `Blood pressure ${bp.sbp}/${bp.dbp} (systolic < ${THRESHOLDS.sbpCritical})`);
  // Signs with no check-in question of their own (parser.OTHER_EMERGENCY). Any code is RED, so a
  // code this table doesn't know yet still reaches a nurse as an emergency.
  if (otherEmergency) flag('RED', otherEmergency in OTHER_EMERGENCY_TEXT ? otherEmergency : 'other_emergency', OTHER_EMERGENCY_TEXT[otherEmergency] ?? 'Emergency sign reported');

  // ---- YELLOW: nurse callback today ----
  if (isNum(d24) && d24 >= THRESHOLDS.gain24hLb)
    flag('YELLOW', 'weight_24h', `Weight up ${d24} lb in 24h (≥ ${THRESHOLDS.gain24hLb})`);
  if (skipped && skipped.delta >= THRESHOLDS.gain72hLb)
    flag('YELLOW', 'weight_72h', `Weight up ${skipped.delta} lb since ${skipped.days} days ago, no reading in between (≥ ${THRESHOLDS.gain72hLb})`);
  if (isNum(d7) && d7 >= THRESHOLDS.gain7dLb)
    flag('YELLOW', 'weight_7d', `Weight up ${d7} lb in 7 days (≥ ${THRESHOLDS.gain7dLb})`);
  // Slow creep: never more than a pound a day, but well above the target weight.
  const latestLb = weights.at(-1)?.lb;
  if (isNum(dryWeightLb) && isNum(latestLb) && latestLb - dryWeightLb >= THRESHOLDS.aboveDryWeightLb && !flags.some((f) => f.code.startsWith('weight_')))
    flag('YELLOW', 'above_dry_weight', `Weight ${round1(latestLb - dryWeightLb)} lb above dry weight (${dryWeightLb} lb)`);
  if (orthopnea) flag('YELLOW', 'orthopnea', 'Needs more pillows / sleeps propped up');
  if (pnd) flag('YELLOW', 'pnd', 'Woke up at night short of breath (PND)');
  if (swelling === 'worse') flag('YELLOW', 'edema_worse', 'Leg/ankle swelling getting worse');
  if (missedDiureticDays >= THRESHOLDS.missedDiureticDays)
    flag('YELLOW', 'missed_diuretic', `Missed diuretic ${missedDiureticDays} days in a row`);
  if (isNum(spo2) && spo2 >= o2.red && spo2 < o2.yellow)
    flag('YELLOW', 'spo2_borderline', `SpO2 ${spo2}% (borderline${copd ? ', COPD' : ''})`);
  if (isBp(bp) && bp.sbp >= THRESHOLDS.sbpCritical && bp.sbp < THRESHOLDS.sbpLow) flag('YELLOW', 'bp_low', `Blood pressure ${bp.sbp}/${bp.dbp} (systolic < ${THRESHOLDS.sbpLow})`);
  if (isBp(bp) && (bp.sbp >= THRESHOLDS.sbpHigh || bp.dbp >= THRESHOLDS.dbpHigh)) flag('YELLOW', 'bp_high', `Blood pressure ${bp.sbp}/${bp.dbp} (very high)`);
  if (isNum(heartRate) && (heartRate > THRESHOLDS.hrHigh || heartRate < THRESHOLDS.hrLow))
    flag('YELLOW', 'hr_abnormal', `Heart rate ${heartRate} bpm`);

  // Judgment rules: a symptom that is mild alone but concerning in context.
  const fluidSigns = flags.some((f) => ['weight_24h', 'weight_7d', 'edema_worse', 'orthopnea', 'pnd'].includes(f.code));
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
  // A big drop on its own (not already explained by the dizzy rule above).
  if (isNum(d24) && d24 <= -THRESHOLDS.weightDropLb && !flags.some((f) => f.code === 'dizzy_dehydration'))
    flag('YELLOW', 'weight_drop', `Weight down ${Math.abs(d24)} lb in 24h (possible over-diuresis, or check the scale reading)`);

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
const isBp = (bp) => !!bp && isNum(bp.sbp) && isNum(bp.dbp);

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
