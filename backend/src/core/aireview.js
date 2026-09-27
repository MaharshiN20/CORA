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

// Test hook: swap the reviewer (e.g. a canned escalate/null result).
export function setReviewer(fn) {
  reviewer = fn ?? ((patient, input) => riskllm.reviewPatient(patient, input));
}

export function queueReview(patientId, rules) {
  const p = run(patientId, rules)
    .catch((err) => console.error('[aireview] failed, rules stand:', err.message))
    .finally(() => pending.delete(p));
  pending.add(p);
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

  const messages = store
    .listMessages(patientId)
    .filter((m) => m.direction === 'in' && m.from !== 'caregiver' && m.text && !m.text.startsWith('['))
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
