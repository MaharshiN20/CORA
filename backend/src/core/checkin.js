// Daily check-in state machine.
//
// Buttons carry answers as "ci:<field>:<value>" (well under Telegram's 64-byte limit).
// Free text is parsed at every step, so "176, ankles more swollen" fills two steps at once.
// Red-flag phrases short-circuit the whole flow to an immediate RED.
import * as store from '../store.js';
import { t } from './i18n.js';
import { scoreRisk } from './risk.js';
import { triage, consecutiveMissedDiureticDays } from './triage.js';
import { escalate } from './escalation.js';
import * as parser from './parser.js';
import * as llm from './llm.js';

// Order matters. `enabled(plan)` lets risk tier decide how deep the check-in goes.
const STEPS = [
  { id: 'weight', done: (a) => a.weightLb != null },
  { id: 'breath', done: (a) => a.breath != null },
  { id: 'orthopnea', done: (a) => a.orthopnea != null, enabled: (plan) => plan.askOrthopnea },
  { id: 'swelling', done: (a) => a.swelling != null },
  { id: 'redflags', done: (a) => a.redflagsAsked },
  { id: 'diuretic', done: (a) => a.diureticTaken != null },
  { id: 'spo2', done: (a) => a.spo2Asked, enabled: (plan) => plan.askSpo2 },
];

const firstName = (p) => p.name.split(' ')[0];
const diureticName = (p) => p.meds.find((m) => m.diuretic)?.name ?? 'water pill';
const btn = (lang, key, data) => ({ label: t(lang, key), data });

// Reply with an English twin so the dashboard can always show what was sent.
function reply(p, key, vars = {}, buttons) {
  const out = { text: t(p.language, key, vars), textEn: t('en', key, vars) };
  if (buttons) out.buttons = buttons;
  return out;
}

function prompt(p, stepId) {
  const L = p.language;
  switch (stepId) {
    case 'weight':
      return reply(p, 'ask_weight');
    case 'breath':
      return reply(p, 'ask_breath', {}, [
        [btn(L, 'breath_normal', 'ci:breath:normal')],
        [btn(L, 'breath_exertion', 'ci:breath:exertion')],
        [btn(L, 'breath_rest', 'ci:breath:rest')],
      ]);
    case 'orthopnea':
      return reply(p, 'ask_orthopnea', {}, [[btn(L, 'yes', 'ci:orth:yes'), btn(L, 'no', 'ci:orth:no')]]);
    case 'swelling':
      return reply(p, 'ask_swelling', {}, [
        [btn(L, 'swelling_none', 'ci:swell:none')],
        [btn(L, 'swelling_mild', 'ci:swell:mild')],
        [btn(L, 'swelling_worse', 'ci:swell:worse')],
      ]);
    case 'redflags':
      return reply(p, 'ask_redflags', {}, [
        [btn(L, 'rf_chest', 'ci:rf:chest'), btn(L, 'rf_dizzy', 'ci:rf:dizzy')],
        [btn(L, 'rf_confused', 'ci:rf:confused'), btn(L, 'rf_fainted', 'ci:rf:fainted')],
        [btn(L, 'rf_none', 'ci:rf:none')],
      ]);
    case 'diuretic':
      return reply(p, 'ask_diuretic', { med: diureticName(p) }, [[btn(L, 'yes', 'ci:diu:yes'), btn(L, 'no', 'ci:diu:no')]]);
    case 'spo2':
      return reply(p, 'ask_spo2', {}, [[btn(L, 'no_device', 'ci:spo2:none')]]);
  }
}

// ---------- applying input ----------

function applyButton(a, data) {
  const [, field, value] = data.split(':');
  switch (field) {
    case 'breath': a.breath = value; break;
    case 'orth': a.orthopnea = value === 'yes'; break;
    case 'swell': a.swelling = value; break;
    case 'diu': a.diureticTaken = value === 'yes'; break;
    case 'spo2': a.spo2Asked = true; break;
    case 'rf':
      a.redflagsAsked = true;
      if (value === 'chest') a.chestPain = true;
      if (value === 'dizzy') a.dizzy = true;
      if (value === 'confused') a.confusion = true;
      if (value === 'fainted') a.fainting = true;
      break;
  }
}

async function applyText(a, text, step) {
  const before = JSON.stringify(a);

  // Step-specific parsing first (numbers and yes/no only make sense in context).
  if (step === 'weight') {
    const lb = parser.parseWeight(text);
    if (lb) a.weightLb = lb;
  } else if (step === 'spo2') {
    const n = parser.parseSpo2(text);
    if (n) { a.spo2 = n; a.spo2Asked = true; }
    else if (parser.isNo(text)) a.spo2Asked = true;
  } else if (step === 'diuretic') {
    if (parser.isYes(text)) a.diureticTaken = true;
    else if (parser.isNo(text)) a.diureticTaken = false;
  } else if (step === 'orthopnea') {
    if (parser.isYes(text)) a.orthopnea = true;
    else if (parser.isNo(text)) a.orthopnea = false;
  } else if (step === 'redflags' && parser.isNo(text)) {
    a.redflagsAsked = true;
  }

  // Then anything else the message mentions, regardless of step.
  const extra = parser.parseFreeText(text);
  for (const [k, v] of Object.entries(extra)) if (a[k] == null) a[k] = v;
  if (extra.chestPain || extra.confusion || extra.fainting) a.redflagsAsked = true;

  // Let the LLM read anything richer than a bare answer ("152", "yes"): keyword lists
  // only cover en/es, so "152, mắt cá chân sưng hơn" must still yield the swelling.
  // It only fills fields the rules left empty; it never overrides them.
  let textEn = null;
  const bareAnswer = /^\s*([\d.,]+\s*(lb|lbs|pounds|libras|kg|%)?|y|yes|no|n|si|sí|ok)\s*$/i.test(text);
  if ((JSON.stringify(a) === before || !bareAnswer) && llm.enabled()) {
    const c = await parser.parseWithLLM(text);
    if (c) {
      textEn = c.textEn ?? null;
      if (c.weightLb && a.weightLb == null && step === 'weight') a.weightLb = c.weightLb;
      for (const k of ['breath', 'orthopnea', 'swelling', 'chestPain', 'dizzy', 'confusion', 'fainting', 'diureticTaken']) {
        if (c[k] != null && a[k] == null) a[k] = c[k];
      }
      if (c.spo2) { a.spo2 = c.spo2; a.spo2Asked = true; }
      if (c.chestPain || c.confusion || c.fainting) a.redflagsAsked = true;
    }
  }
  return { understood: JSON.stringify(a) !== before, textEn };
}

const isEmergency = (a) => a.chestPain || a.breath === 'rest' || a.confusion || a.fainting || (a.spo2 != null && a.spo2 < 90);

// ---------- public API ----------

export function isActive(patient) {
  return patient.checkin?.state && patient.checkin.state !== 'idle';
}

export function start(patient) {
  const { plan } = scoreRisk(patient);
  const steps = STEPS.filter((s) => !s.enabled || s.enabled(plan));
  store.updatePatient(patient.id, { checkin: { state: steps[0].id, answers: {}, startedAt: new Date().toISOString() } });
  return [reply(patient, 'greeting', { name: firstName(patient) }), prompt(patient, steps[0].id)];
}

// Returns { replies, textEn } where textEn is an English translation of the inbound text, if we made one.
export async function handle(patient, { text, buttonData }) {
  const { plan } = scoreRisk(patient);
  const steps = STEPS.filter((s) => !s.enabled || s.enabled(plan));
  const state = patient.checkin;
  const a = state.answers;
  let understood = true;
  let textEn = null;

  if (buttonData?.startsWith('ci:')) applyButton(a, buttonData);
  else if (text) ({ understood, textEn } = await applyText(a, text, state.state));

  if (isEmergency(a)) return { replies: await finish(patient, a), textEn };

  const next = steps.find((s) => !s.done(a));
  if (!next) return { replies: await finish(patient, a), textEn };

  store.updatePatient(patient.id, { checkin: { ...state, state: next.id, answers: a } });
  const replies = [];
  if (!understood && next.id === 'weight') replies.push(reply(patient, 'bad_weight'));
  else replies.push(prompt(patient, next.id));
  return { replies, textEn };
}

async function finish(patient, a) {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  // Record today's weight (replace if already logged today).
  const weights = patient.weights.filter((w) => w.ts.slice(0, 10) !== today);
  if (a.weightLb != null) weights.push({ ts: now, lb: a.weightLb });
  else if (patient.weights.at(-1)?.ts.slice(0, 10) === today) weights.push(patient.weights.at(-1));

  const doses = [...(patient.doses ?? [])];
  if (a.diureticTaken != null) doses.push({ ts: now, med: diureticName(patient), diuretic: true, taken: a.diureticTaken });

  const result = triage({ weights, answers: a, missedDiureticDays: consecutiveMissedDiureticDays(doses) });
  const record = { ts: now, answers: a, tier: result.tier, flags: result.flags, weight: result.weight };

  store.updatePatient(patient.id, {
    weights,
    doses,
    checkin: { state: 'idle', answers: {} },
    checkins: [...(patient.checkins ?? []), record],
    lastTier: result.tier,
    lastCheckinAt: now,
  });
  const fresh = store.getPatient(patient.id);
  await escalate(fresh, result);

  const name = firstName(patient);
  const replies = [];
  if (result.tier === 'RED') {
    replies.push({ ...reply(patient, 'red_911', { name, caregiver: patient.caregiver?.name?.split(' ')[0] ?? 'your family' }), urgent: true });
    return replies;
  }
  replies.push(reply(patient, result.tier === 'YELLOW' ? 'thanks_yellow' : 'thanks_green', { name }));
  if (result.advice.length) {
    const lines = result.advice.map((code) => `• ${t(patient.language, `advice_${code}`)}`);
    const linesEn = result.advice.map((code) => `• ${t('en', `advice_${code}`)}`);
    replies.push({
      text: `${t(patient.language, 'advice_header')}\n${lines.join('\n')}`,
      textEn: `${t('en', 'advice_header')}\n${linesEn.join('\n')}`,
    });
  }
  return replies;
}

// Emergency phrase outside a check-in ("my chest hurts"): triage + escalate right away.
export async function handleUrgentFreeText(patient, text) {
  const extra = parser.parseFreeText(text);
  if (!isEmergency(extra)) return null;
  const result = triage({ weights: patient.weights, answers: extra });
  store.updatePatient(patient.id, { lastTier: result.tier });
  await escalate(store.getPatient(patient.id), result, { source: 'unprompted message' });
  return [{ ...reply(patient, 'red_interrupt'), urgent: true }];
}
