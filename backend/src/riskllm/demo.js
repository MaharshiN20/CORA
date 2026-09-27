// Try the risk LLM on a patient the rules call GREEN. Uses the shared provider chain:
// Claude (ANTHROPIC_API_KEY) -> Ollama -> LM Studio. Free/offline: `ollama pull qwen2.5:7b`.
//   cd backend && node --env-file-if-exists=.env src/riskllm/demo.js
import { reviewPatient, enabled } from './index.js';
import * as llm from '../core/llm/index.js';
import * as clock from '../core/clock.js';

const DAY = 24 * 60 * 60 * 1000;
const iso = (daysAgo) => new Date(clock.now() - daysAgo * DAY).toISOString();
const log = (lbs) => lbs.map((lb, i) => ({ ts: iso(lbs.length - 1 - i), lb }));

// Robert: every check-in "fine", no single-day jump >= 2 lb, but weight creeping,
// eating salty food, sleeping in a recliner, diuretic refill never picked up.
const patient = {
  age: 71,
  dischargedAt: iso(6),
  dryWeightLb: 205,
  profile: { priorAdmits12mo: 1, ejectionFraction: 35, lengthOfStay: 4, diabetes: true, copd: true, livesAlone: false },
  meds: [
    { name: 'Furosemide', dose: '40 mg', diuretic: true },
    { name: 'Carvedilol', dose: '12.5 mg' },
    { name: 'Lisinopril', dose: '10 mg' },
  ],
  weights: log([205, 205.6, 206.3, 207, 207.9, 208.8]),
  doses: [
    { ts: iso(2), diuretic: true, taken: true },
    { ts: iso(1), diuretic: true, taken: true },
    { ts: iso(0), diuretic: true, taken: false },
  ],
  prescriptions: [{ med: 'Furosemide', expectedPickup: iso(5), pickedUpAt: null }],
  caregiver: { relation: 'wife' },
  checkins: [1, 2, 3].map((d) => ({ ts: iso(d), tier: 'GREEN', answers: { breath: 'normal', swelling: 'mild' } })),
};

const messages = [
  { ts: iso(3), text: "feeling ok. Linda's out of town this week" },
  { ts: iso(2), text: 'grabbed mcdonalds, didnt feel like cooking' },
  { ts: iso(1), text: 'cant lay flat so im propped up on the couch lol' },
  { ts: iso(0), text: 'fine. no swelling i think but my sneakers dont fit. couldnt pick up the lasix' },
];

if (!enabled()) {
  console.error('Risk LLM is off (RISK_LLM=off).');
  process.exit(1);
}
await llm.detect();
if (!llm.enabled()) {
  console.error("No LLM provider available (set ANTHROPIC_API_KEY, or start Ollama / LM Studio).");
  process.exit(1);
}
console.error(`Reviewing with ${llm.status().provider} (${llm.status().model})... local CPU models can take 1-2 min`);
const t0 = Date.now();
const review = await reviewPatient(patient, { rules: { tier: 'GREEN', flags: [] }, messages });
console.log(JSON.stringify(review, null, 2));
console.error(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
