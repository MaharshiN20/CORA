// Deterministic features for the risk LLM. Pure: no I/O, no LLM, clock passed in.
// We compute the numbers here so the LLM reasons about facts instead of doing math.
//
// Patient shape (same as the seed data):
//   { age, language, dischargedAt, dryWeightLb, profile: {...}, meds: [...],
//     weights: [{ ts, lb }], doses: [{ ts, med, taken, diuretic }],
//     prescriptions: [{ med, expectedPickup, pickedUpAt }], caregiver: {...},
//     checkins: [{ ts, tier, answers }] }

import { matchCues } from './lexicon.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const round2 = (n) => Math.round(n * 100) / 100;

// Change vs. a reading 12-48h before the latest.
export function change24h(weights) {
  const latest = weights.at(-1);
  if (!latest) return null;
  const t = Date.parse(latest.ts);
  for (let i = weights.length - 2; i >= 0; i--) {
    const age = t - Date.parse(weights[i].ts);
    if (age >= 12 * HOUR && age <= 48 * HOUR) return round2(latest.lb - weights[i].lb);
    if (age > 48 * HOUR) break;
  }
  return null;
}

// Change vs. the oldest reading in the last ~7 days.
export function change7d(weights) {
  const latest = weights.at(-1);
  if (!latest) return null;
  const t = Date.parse(latest.ts);
  const base = weights.find((w) => {
    const age = t - Date.parse(w.ts);
    return age > 0 && age <= 7.5 * DAY;
  });
  return base ? round2(latest.lb - base.lb) : null;
}

// Least-squares slope in lb/day over the last `n` readings.
export function slope(weights, n = 7) {
  const pts = weights.slice(-n).map((w) => ({ x: Date.parse(w.ts) / DAY, y: w.lb }));
  if (pts.length < 3) return null;
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const num = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
  const den = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  return den ? round2(num / den) : null;
}

// Readings in a row (ending with the latest) that went up vs. the one before.
export function consecutiveGains(weights) {
  let n = 0;
  for (let i = weights.length - 1; i > 0 && weights[i].lb > weights[i - 1].lb; i--) n++;
  return n;
}

// Consecutive most-recent days the diuretic was missed.
export function missedDiureticStreak(doses = []) {
  const byDay = new Map();
  for (const d of doses.filter((x) => x.diuretic)) {
    const day = d.ts.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? false) || d.taken);
  }
  let n = 0;
  for (const day of [...byDay.keys()].sort().reverse()) {
    if (byDay.get(day)) break;
    n++;
  }
  return n;
}

export function unfilledPrescriptions(prescriptions = [], now) {
  return prescriptions
    .filter((rx) => !rx.pickedUpAt && Date.parse(rx.expectedPickup) < now)
    .map((rx) => ({ med: rx.med, daysOverdue: Math.floor((now - Date.parse(rx.expectedPickup)) / DAY) }));
}

// Deterministic signals the LLM gets as hints; anything it doesn't cover still reaches the nurse.
export function detectSignals(caseData, messages = []) {
  const out = [];
  const w = caseData.weight ?? {};
  if (w.slopeLbPerDay >= 0.5 && w.consecutiveGainDays >= 3)
    out.push({
      category: 'fluid_trend',
      text: 'Steady weight gain below the single-day alert threshold',
      evidence: `+${w.slopeLbPerDay} lb/day, up ${w.consecutiveGainDays} readings in a row${w.aboveDryWeightLb != null ? `, ${w.aboveDryWeightLb} lb above dry weight` : ''}`,
    });
  for (const rx of caseData.adherence?.unfilledPrescriptions ?? [])
    out.push({ category: 'refill', text: `${rx.med} prescription not picked up`, evidence: `${rx.daysOverdue} days overdue` });
  const streak = caseData.adherence?.missedDiureticStreakDays;
  if (streak >= 1) out.push({ category: 'medication', text: 'Diuretic missed', evidence: `${streak} day(s) in a row` });

  // Keyword lexicon (lexicon.js): one signal per sign, quoting the first message that hit it.
  const seen = new Set();
  for (const m of messages) {
    for (const hit of matchCues(m.text)) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      out.push({ category: hit.category, text: hit.sign, evidence: `"${m.text}" (${String(m.ts ?? '').slice(0, 10)})` });
    }
  }
  return out;
}

const ANSWER_KEYS = ['weightLb', 'breath', 'orthopnea', 'swelling', 'chestPain', 'dizzy', 'confusion', 'fainting', 'diureticTaken', 'spo2'];

function pickAnswers(a = {}) {
  return Object.fromEntries(ANSWER_KEYS.filter((k) => a[k] != null).map((k) => [k, a[k]]));
}

// Everything the LLM sees about the patient, minus their free-text messages.
// `rules` is today's deterministic triage result ({ tier, flags }) if there is one.
export function buildCase(patient, { rules = null, now = Date.now() } = {}) {
  const weights = patient.weights ?? [];
  const latest = weights.at(-1);
  const doses7d = (patient.doses ?? []).filter((d) => d.diuretic && now - Date.parse(d.ts) <= 7 * DAY);
  const p = patient.profile ?? {};

  return {
    patient: {
      age: patient.age,
      daysSinceDischarge: patient.dischargedAt ? Math.floor((now - Date.parse(patient.dischargedAt)) / DAY) : null,
      ejectionFraction: p.ejectionFraction ?? null,
      priorAdmits12mo: p.priorAdmits12mo ?? null,
      lengthOfStay: p.lengthOfStay ?? null,
      comorbidities: ['ckd', 'diabetes', 'copd'].filter((k) => p[k]),
      livesAlone: !!p.livesAlone,
      caregiver: patient.caregiver?.relation ?? null,
      meds: (patient.meds ?? []).map((m) => `${m.name} ${m.dose}${m.diuretic ? ' (diuretic)' : ''}`),
    },
    weight: {
      dryWeightLb: patient.dryWeightLb ?? null,
      latestLb: latest?.lb ?? null,
      aboveDryWeightLb: latest && patient.dryWeightLb ? round2(latest.lb - patient.dryWeightLb) : null,
      change24hLb: change24h(weights),
      change7dLb: change7d(weights),
      slopeLbPerDay: slope(weights),
      consecutiveGainDays: consecutiveGains(weights),
      last7: weights.slice(-7).map((w) => ({ date: w.ts.slice(0, 10), lb: w.lb })),
    },
    adherence: {
      diureticDosesLogged7d: doses7d.length,
      diureticDosesTaken7d: doses7d.filter((d) => d.taken).length,
      missedDiureticStreakDays: missedDiureticStreak(patient.doses),
      unfilledPrescriptions: unfilledPrescriptions(patient.prescriptions, now),
    },
    todaysRulesTriage: rules ? { tier: rules.tier, flags: (rules.flags ?? []).map((f) => f.text ?? f) } : null,
    recentCheckins: (patient.checkins ?? []).slice(-5).map((c) => ({
      date: c.ts.slice(0, 10),
      tier: c.tier,
      answers: pickAnswers(c.answers),
    })),
  };
}
