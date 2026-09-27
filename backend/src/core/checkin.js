// Daily check-in state machine.
//
// Buttons carry answers as "ci:<field>:<value>" (well under Telegram's 64-byte limit).
// Free text is parsed at every step, so "176, ankles more swollen" fills two steps at once.
// Red-flag phrases short-circuit the whole flow to an immediate RED.
import * as store from '../store.js';
import { t, hasNative } from './i18n.js';
import { scoreRisk } from './risk.js';
import { getSignals } from './signals.js';
import { triage, consecutiveMissedDiureticDays } from './triage.js';
import { escalate } from './escalation.js';
import * as parser from './parser.js';
import * as llm from './llm.js';
import * as clock from './clock.js';
import { applyDiureticAnswer } from './meds.js';
import { localDayKey } from './planning.js';
import { queueReview } from './aireview.js';

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

// A check-in is answered either by the patient or, as a proxy, by their caregiver
// (P1-7). A proxy check-in speaks the caregiver's language and says "Maria" instead of "you".
const langOf = (p) => p.checkin?.lang ?? p.language;

// Reply with an English twin so the dashboard can always show what was sent.
function replyIn(lang, key, vars = {}, buttons) {
  const out = { text: t(lang, key, vars), textEn: t('en', key, vars) };
  if (buttons) out.buttons = buttons;
  return out;
}
const reply = (p, key, vars, buttons) => replyIn(langOf(p), key, vars, buttons);

function prompt(p, stepId) {
  const L = langOf(p);
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

// A weight far from the last one is usually a typo or the wrong units ("250" instead of
// "150", kg typed as lb). Hold it until the patient confirms, instead of paging a nurse
// about a 73-lb overnight gain.
const IMPLAUSIBLE_CHANGE_LB = 15;
function confirmWeight(a) {
  a.weightLb = a.weightPending;
  a.weightConfirmed = true;
  delete a.weightPending;
}
function holdImplausibleWeight(patient, a) {
  const last = patient.weights?.at(-1)?.lb;
  if (a.weightLb == null || a.weightConfirmed || last == null) return;
  if (Math.abs(a.weightLb - last) > IMPLAUSIBLE_CHANGE_LB) {
    a.weightPending = a.weightLb;
    delete a.weightLb;
  }
}
function weightConfirmPrompt(p, a) {
  const last = p.weights.at(-1).lb;
  const diff = Math.round(Math.abs(a.weightPending - last) * 10) / 10;
  const key = a.weightPending > last ? 'weight_confirm_up' : 'weight_confirm_down';
  const L = langOf(p);
  return reply(p, key, { diff, last, lb: a.weightPending }, [
    [{ label: t(L, 'weight_confirm_yes', { lb: a.weightPending }), data: 'ci:wconf:yes' }],
    [{ label: t(L, 'weight_confirm_no'), data: 'ci:wconf:no' }],
  ]);
}

function applyButton(a, data) {
  const [, field, value] = data.split(':');
  switch (field) {
    case 'wconf':
      if (value === 'yes' && a.weightPending != null) confirmWeight(a);
      else delete a.weightPending;
      break;
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
    if (lb) {
      a.weightLb = lb;
      delete a.weightPending;
    } else if (a.weightPending && parser.isYes(text)) confirmWeight(a);
    else if (a.weightPending && parser.isNo(text)) delete a.weightPending;
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

// Only the fields the emergency rule reads; anything else the LLM returns is ignored here.
const pickEmergencyFields = (c) => ({
  ...(c.chestPain === true && { chestPain: true }),
  ...(c.confusion === true && { confusion: true }),
  ...(c.fainting === true && { fainting: true }),
  ...(c.breath === 'rest' && { breath: 'rest' }),
  ...(typeof c.spo2 === 'number' && { spo2: c.spo2 }),
});

const isEmergency = (a) => a.chestPain || a.breath === 'rest' || a.confusion || a.fainting || (a.spo2 != null && a.spo2 < 90);

// ---------- public API ----------

export function isActive(patient) {
  return patient.checkin?.state && patient.checkin.state !== 'idle';
}

// The question the patient is currently on (for reminders), or null if no check-in is running.
export function currentPrompt(patient) {
  return isActive(patient) ? prompt(patient, patient.checkin.state) : null;
}

// reporter: 'patient' (default) or 'caregiver' (proxy check-in, lang = caregiver's language).
export function start(patient, { reporter = 'patient', lang } = {}) {
  const { plan } = scoreRisk(patient, getSignals(patient)); // live tier (Risk v2) drives check-in depth
  const steps = STEPS.filter((s) => !s.enabled || s.enabled(plan));
  const checkin = { state: steps[0].id, answers: {}, startedAt: clock.nowISO(), reporter };
  if (reporter === 'caregiver') checkin.lang = lang ?? patient.caregiver?.language ?? 'en';
  store.updatePatient(patient.id, { checkin });
  const greeting = reporter === 'caregiver' ? 'proxy_greeting' : 'greeting';
  return [reply(patient, greeting, { name: firstName(patient) }), prompt(patient, steps[0].id)];
}

// The patient volunteered a symptom outside a check-in ("my ankles are more swollen"):
// start a check-in and apply what they said, so they're only asked what's missing.
export async function startWith(patient, text) {
  start(patient);
  const { replies, textEn } = await handle(store.getPatient(patient.id), { text });
  return { replies: [reply(patient, 'companion_symptom_intro'), ...replies], textEn };
}

export const reporterOf = (patient) => (isActive(patient) ? patient.checkin.reporter ?? 'patient' : null);

// Returns { replies, textEn } where textEn is an English translation of the inbound text, if we made one.
export async function handle(patient, { text, buttonData }) {
  const { plan } = scoreRisk(patient, getSignals(patient)); // live tier (Risk v2) drives check-in depth
  const steps = STEPS.filter((s) => !s.enabled || s.enabled(plan));
  const state = patient.checkin;
  const a = state.answers;
  let understood = true;
  let textEn = null;

  if (buttonData?.startsWith('ci:')) applyButton(a, buttonData);
  else if (text) ({ understood, textEn } = await applyText(a, text, state.state));
  holdImplausibleWeight(patient, a);

  // Emergencies never wait for a weight confirmation.
  if (isEmergency(a)) return { replies: await finish(patient, a), textEn };

  const next = steps.find((s) => !s.done(a));
  if (!next) return { replies: await finish(patient, a), textEn };

  store.updatePatient(patient.id, { checkin: { ...state, state: next.id, answers: a } });
  const replies = [];
  if (next.id === 'weight' && a.weightPending != null) replies.push(weightConfirmPrompt(patient, a));
  else if (!understood && next.id === 'weight') replies.push(reply(patient, 'bad_weight'));
  else replies.push(prompt(patient, next.id));
  return { replies, textEn };
}

async function finish(patient, a) {
  const now = clock.nowISO();
  const today = localDayKey(clock.now());
  const dayOf = (w) => localDayKey(Date.parse(w.ts));

  // Record today's weight (replace if already logged today, by local calendar day).
  const weights = patient.weights.filter((w) => dayOf(w) !== today);
  if (a.weightLb != null) weights.push({ ts: now, lb: a.weightLb });
  else if (patient.weights.at(-1) && dayOf(patient.weights.at(-1)) === today) weights.push(patient.weights.at(-1));

  // The water-pill answer merges into today's reminder dose instead of duplicating it.
  const doses = a.diureticTaken != null ? applyDiureticAnswer(patient, a.diureticTaken, now) : [...(patient.doses ?? [])];

  // Captured before the check-in state is reset below.
  const lang = langOf(patient);
  const reporter = patient.checkin?.reporter ?? 'patient';
  const proxy = reporter === 'caregiver';

  const result = triage({ weights, answers: a, missedDiureticDays: consecutiveMissedDiureticDays(doses) });
  const record = { ts: now, answers: a, tier: result.tier, flags: result.flags, weight: result.weight, reporter };

  store.updatePatient(patient.id, {
    weights,
    doses,
    checkin: { state: 'idle', answers: {} },
    checkins: [...(patient.checkins ?? []), record],
    lastTier: result.tier,
    lastCheckinAt: now,
  });
  await escalate(store.getPatient(patient.id), result, { reporter });
  // Re-score with today's answers + alerts so the dashboard and tomorrow's plan follow the
  // live (Risk v2) tier; trend is vs the previous saved score.
  const scored = store.getPatient(patient.id);
  const live = scoreRisk(scored, getSignals(scored));
  store.updatePatient(patient.id, {
    riskScore: live.score,
    riskTier: live.tier,
    riskFactors: live.factors,
    riskBaseline: live.baseline,
    riskDynamic: live.dynamic,
  });
  // AI second look + risk history, in the background (never delays the reply).
  queueReview(patient.id, result);

  const name = firstName(patient);
  const replies = [];
  if (result.tier === 'RED') {
    const key = proxy ? 'proxy_red_911' : 'red_911';
    replies.push({ ...replyIn(lang, key, { name, caregiver: patient.caregiver?.name?.split(' ')[0] ?? 'your family' }), urgent: true });
    return replies;
  }
  const thanks = result.tier === 'YELLOW' ? 'thanks_yellow' : 'thanks_green';
  replies.push(replyIn(lang, proxy ? `proxy_${thanks}` : thanks, { name }));
  if (result.advice.length) {
    const lines = result.advice.map((code) => `• ${t(lang, `advice_${code}`)}`);
    const linesEn = result.advice.map((code) => `• ${t('en', `advice_${code}`)}`);
    replies.push({
      text: `${t(lang, 'advice_header')}\n${lines.join('\n')}`,
      textEn: `${t('en', 'advice_header')}\n${linesEn.join('\n')}`,
    });
  }
  return replies;
}

// Emergency phrase outside a check-in ("my chest hurts"): triage + escalate right away.
// A caregiver can report one too ("mom has chest pain"): same triage, reply addressed to them.
// Languages without hand-written red-flag patterns (vi, hi, zh...): if the rules find
// nothing, the LLM *parses* the message and the same isEmergency rule decides (the LLM
// never picks the tier). en/es stay rules-only: the eval gate shows the rules catch them all.
export async function handleUrgentFreeText(patient, text, { reporter = 'patient', lang } = {}) {
  let extra = parser.parseFreeText(text);
  const msgLang = lang ?? patient.language;
  if (!isEmergency(extra) && !hasNative(msgLang) && llm.enabled()) {
    const c = await parser.parseWithLLM(text);
    if (c) {
      extra = { ...extra, ...pickEmergencyFields(c) };
      if (isEmergency(extra)) store.audit('llm_parse', patient.id, { purpose: 'unprompted_emergency', lang: msgLang, flags: pickEmergencyFields(c) });
    }
  }
  if (!isEmergency(extra)) return null;
  const result = triage({ weights: patient.weights, answers: extra });
  store.updatePatient(patient.id, { lastTier: result.tier });
  const proxy = reporter === 'caregiver';
  await escalate(store.getPatient(patient.id), result, { source: proxy ? 'caregiver message' : 'unprompted message', reporter });
  const key = proxy ? 'proxy_red_911' : 'red_interrupt';
  return [{ ...replyIn(lang ?? patient.language, key, { name: firstName(patient) }), urgent: true }];
}
