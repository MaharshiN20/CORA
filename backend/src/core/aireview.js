// Post-check-in AI review (P1-9). Wires Maharshi's escalate-only reviewer
// (riskllm/reviewPatient) and risk history (risk.recordRisk, once M1 lands) into
// every completed check-in.
//
//   queueReview(patientId, rules)  // called by checkin.finish; never blocks the patient's reply
//   flushReviews()                 // tests / e2e: wait for queued reviews
//
// Safety: the reviewer only runs when the shared LLM chain has a provider, only
// acts on a GREEN rules result (never touches YELLOW/RED), and can only add a
// YELLOW "nurse review" alert with its evidence. Rules stand whenever it returns null.
import * as store from '../store.js';
import * as clock from './clock.js';
import * as channels from '../channels/index.js';
import * as llm from './llm/index.js';
import * as risk from './risk.js';
import * as riskllm from '../riskllm/index.js';

let reviewer = (patient, input) => riskllm.reviewPatient(patient, input);
const pending = new Set();
const byPatient = new Map(); // patientId -> its in-flight review promise

// A local model can take minutes per review. Three patients finishing check-ins together must not
// start three model calls at once (or twenty at a cohort's morning rush): at most MAX_CONCURRENT
// run, the rest wait in order.
const MAX_CONCURRENT = 2;
let active = 0;
const waiting = [];
async function slot(fn) {
  if (active >= MAX_CONCURRENT) await new Promise((resolve) => waiting.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

// Test hook: swap the reviewer (e.g. a canned escalate/null result).
export function setReviewer(fn) {
  reviewer = fn ?? ((patient, input) => riskllm.reviewPatient(patient, input));
}

// One review per patient at a time: a second check-in finishing while the first is still being
// reviewed joins it instead of paying for another model call.
export function queueReview(patientId, rules) {
  const inflight = byPatient.get(patientId);
  if (inflight) return inflight;
  const p = slot(() => run(patientId, rules))
    .catch((err) => console.error('[aireview] failed, rules stand:', err.message))
    .finally(() => {
      pending.delete(p);
      byPatient.delete(patientId);
    });
  pending.add(p);
  byPatient.set(patientId, p);
  return p;
}

export async function flushReviews() {
  while (pending.size) await Promise.all([...pending]);
}

async function run(patientId, rules) {
  const patient = store.getPatient(patientId);
  if (!patient) return null;

  // Risk history (Maharshi M1). Optional until his recordRisk export exists.
  if (typeof risk.recordRisk === 'function') risk.recordRisk(patient);

  // The reviewer only adds value on a GREEN day (rules already escalated otherwise),
  // and only when a model is actually available.
  if (rules.tier !== 'GREEN' || !llm.enabled() || !riskllm.enabled()) return null;

  // A nurse already has an AI-review alert open for this patient: a second one adds nothing.
  if (store.listAlerts(patientId).some((a) => a.source === 'ai_review' && a.status !== 'resolved')) return null;

  // Only what the patient said since the last review, so one old "slept in the recliner" can't
  // raise a fresh alert after every GREEN check-in until it scrolls out of the window. The mark is
  // taken when this review starts, so a message that arrives while the model is thinking is still
  // seen next time.
  const lastReview = Date.parse(patient.lastAiReviewAt ?? 0) || 0;
  store.updatePatient(patientId, { lastAiReviewAt: clock.nowISO() });
  const messages = store
    .listMessages(patientId)
    .filter((m) => m.direction === 'in' && m.from !== 'caregiver' && m.text && !m.text.startsWith('[') && Date.parse(m.ts) > lastReview)
    .slice(-12)
    .map((m) => ({ ts: m.ts, text: m.textEn ?? m.text }));

  const review = await reviewer(patient, { rules: { tier: rules.tier, flags: rules.flags ?? [] }, messages, now: clock.now() });
  if (!review) return null;

  store.audit('ai_review', patientId, {
    rulesTier: review.rulesTier,
    aiTier: review.aiTier,
    finalTier: review.finalTier,
    escalate: review.escalate,
    readmissionRisk: review.readmissionRisk,
    model: review.model,
  });

  // Belt and braces: act only on GREEN -> YELLOW, whatever the reviewer returns.
  if (!review.escalate || review.finalTier !== 'YELLOW') return review;

  const reasons = (review.concerns ?? []).map((c) => (c.evidence ? `${c.text} (patient: "${c.evidence}")` : c.text));
  store.addAlert({
    patientId,
    kind: 'triage',
    tier: 'YELLOW',
    source: 'ai_review',
    title: `AI review: ${review.concerns?.[0]?.text ?? 'nurse review suggested'}`,
    reasons: reasons.length ? reasons : ['AI reviewer suggested a nurse call'],
    nurseSummary: review.nurseSummary,
    suggestedActions: review.suggestedActions,
    readmissionRisk: review.readmissionRisk,
    model: review.model,
  });
  await channels.sendToNurses({
    text: `🤖⚠️ AI review flagged ${patient.name} (rules said GREEN)\n${reasons.map((r) => `• ${r}`).join('\n')}\n${review.nurseSummary ?? ''}`.trim(),
  });
  return review;
}
