// Synthetic historical cohort: ~60 finished 30-day journeys, so the impact page has a
// realistic population to show before the live demo has any history. Deterministic
// (seeded PRNG), so the same seed always gives the same numbers on stage.
//
// Stored in store.collection('cohort') and NEVER mixed into the live patients list.
// The effect sizes follow the evidence in docs/STRATEGY.md:
//   - readmission ~20% overall; engaged patients ~8% vs ~24% (text-program study),
//   - engagement decays with days since discharge (the Tele-HF / BEAT-HF failure mode),
//   - non-English patients are served in their language, so they engage about as well.
import * as store from '../store.js';
import { WINDOW_DAYS } from './journeys.js';

export const DEFAULT_SEED = 20260926;
export const DEFAULT_SIZE = 60;
const BASE_DISCHARGE = Date.parse('2026-06-01T09:00:00Z'); // fixed so output never depends on "now"
const DAY = 24 * 60 * 60 * 1000;

// mulberry32: tiny, fast, good enough for demo data.
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}


function pickWeighted(rand, items) {
  let r = rand();
  for (const [value, w] of items) if ((r -= w) < 0) return value;
  return items.at(-1)[0];
}

const between = (rand, lo, hi) => lo + rand() * (hi - lo);
const intBetween = (rand, lo, hi) => Math.floor(between(rand, lo, hi + 1));

function journey(rand, i) {
  // How likely this patient is to keep answering. Bimodal: most engage; the rest drift
  // off and then stop for good on a "dropout day", the failure mode that sank Tele-HF.
  const steady = rand() < 0.62;
  const propensity = steady ? between(rand, 0.72, 0.95) : between(rand, 0.35, 0.65);
  const decayPerDay = steady ? 0.004 : 0.012;
  const dropoutDay = steady ? Infinity : intBetween(rand, 4, 18);

  const responses = [];
  const alerts = [];
  let missedStreak = 0;
  for (let day = 1; day <= WINDOW_DAYS; day++) {
    const gone = day >= dropoutDay;
    const p = gone ? 0.03 : Math.max(0.05, propensity - decayPerDay * day);
    let responded = rand() < p;
    let recoveredVia = null;
    if (!responded) {
      // The escalation ladder: a reminder nudge, then the caregiver. It works far less
      // often once a patient has checked out.
      const k = gone ? 0.3 : 1;
      if (rand() < 0.22 * k) [responded, recoveredVia] = [true, 'nudge'];
      else if (rand() < 0.15 * k) [responded, recoveredVia] = [true, 'caregiver'];
    }
    responses.push({ day, responded, recoveredVia });
    missedStreak = responded ? 0 : missedStreak + 1;

    if (responded) {
      const r = rand();
      if (r < 0.012) alerts.push(alert(rand, 'RED', 'triage'));
      else if (r < 0.07) alerts.push(alert(rand, 'YELLOW', 'triage'));
    } else if (missedStreak === 2) {
      alerts.push(alert(rand, 'YELLOW', 'unreachable'));
    }
    if (rand() < 0.01) alerts.push(alert(rand, 'INFO', 'refill'));
  }

  const responded = responses.filter((r) => r.responded).length;

  return {
    id: `cohort-${String(i + 1).padStart(3, '0')}`,
    patientId: null,
    source: 'cohort',
    language: null, // assigned in generateCohort, balanced across engagement
    dischargedAt: new Date(BASE_DISCHARGE + i * 0.5 * DAY).toISOString(),
    days: WINDOW_DAYS,
    responses,
    alerts,
    readmitted: false, // assigned in generateCohort to hit the evidence-based rates
    refillGapDays: rand() < 0.2 ? intBetween(rand, 2, 9) : 0,
    rpmDays: responded,
    _tiebreak: rand(),
  };
}

// 60 patients is a small sample, so pure dice rolls can swing readmission from 7% to 30%.
// Instead: exactly round(rate * n) readmissions per engagement group (chosen at random),
// and languages dealt round-robin in order of engagement so every language gets the same
// mix. That is the program's claim (served equally in every language), stated up front.
export const READMIT_RATE = { engaged: 0.08, notEngaged: 0.24 };
const LANGUAGE_DEAL = ['en', 'es', 'en', 'vi', 'es', 'en', 'hi', 'es', 'en', 'zh']; // 40/30/10/10/10

const answeredShare = (j) => j.responses.filter((r) => r.responded).length / j.responses.length;

function alert(rand, tier, kind) {
  // Nurses act fast on RED, within the SLA on YELLOW, and within a day on INFO.
  const ack = { RED: [3, 25], YELLOW: [20, 260], INFO: [120, 1400] }[tier];
  const outcome =
    tier === 'RED'
      ? pickWeighted(rand, [['true_positive', 0.55], ['ed_avoided', 0.3], ['false_positive', 0.15]])
      : pickWeighted(rand, [['true_positive', 0.7], ['false_positive', 0.25], ['other', 0.05]]);
  return { tier, kind, status: 'resolved', outcome, ackMinutes: intBetween(rand, ...ack) };
}

export function generateCohort({ seed = DEFAULT_SEED, size = DEFAULT_SIZE } = {}) {
  const rand = prng(seed);
  const js = Array.from({ length: size }, (_, i) => journey(rand, i));

  for (const [engaged, target] of [[true, READMIT_RATE.engaged], [false, READMIT_RATE.notEngaged]]) {
    const group = js.filter((j) => answeredShare(j) >= 0.6 === engaged).sort((a, b) => a._tiebreak - b._tiebreak);
    group.slice(0, Math.round(target * group.length)).forEach((j) => (j.readmitted = true));
  }
  [...js]
    .sort((a, b) => answeredShare(b) - answeredShare(a) || a._tiebreak - b._tiebreak)
    .forEach((j, k) => (j.language = LANGUAGE_DEAL[k % LANGUAGE_DEAL.length]));

  return js.map(({ _tiebreak, ...j }) => j);
}

// Replace the stored cohort (in place, so references to the collection stay valid).
export function regenerateCohort(opts) {
  const rows = store.collection('cohort');
  rows.splice(0, rows.length, ...generateCohort(opts));
  store.persist('update', null);
  return rows;
}

// Lazily create the cohort the first time insights are asked for.
export function ensureCohort() {
  const rows = store.collection('cohort');
  return rows.length ? rows : regenerateCohort();
}
