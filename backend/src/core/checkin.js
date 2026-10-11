// Daily check-in state machine.
//
// Buttons carry answers as "ci:<field>:<value>" (well under Telegram's 64-byte limit).
// Free text is parsed at every step, so "176, ankles more swollen" fills two steps at once.
// Red-flag phrases short-circuit the whole flow to an immediate RED.
import * as store from '../store.js';
import { t, hasNative } from './i18n.js';
import { scoreRisk } from './risk.js';
import { getSignals } from './signals.js';
import { triage, consecutiveMissedDiureticDays, spo2Thresholds } from './triage.js';
import { escalate } from './escalation.js';
import * as parser from './parser.js';
import * as llm from './llm.js';
import * as clock from './clock.js';
import { applyDiureticAnswer } from './meds.js';
import { localDayKey } from './planning.js';
import { queueReview } from './aireview.js';
import * as companion from './companion.js';

// Order matters. Emergencies are screened first, so a patient with chest pain is told to
// call 911 after one tap instead of after five questions.
// `enabled(plan)` lets risk tier decide how deep the check-in goes.
const STEPS = [
  { id: 'redflags', done: (a) => a.redflagsAsked },
  { id: 'weight', done: (a) => a.weightLb != null || a.weightSkipped },
  { id: 'breath', done: (a) => a.breath != null },
  { id: 'orthopnea', done: (a) => a.orthopnea != null || a.pnd != null, enabled: (plan) => plan.askOrthopnea },
  { id: 'swelling', done: (a) => a.swelling != null },
  // "Not yet" (a morning check-in before the dose) answers the question without counting as missed.
  { id: 'diuretic', done: (a) => a.diureticTaken != null || a.diureticAsked },
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

// Safety net. The rules read every English and Spanish emergency; in other languages they know
// a hand-written subset (core/redflags-intl.js) and otherwise lean on the LLM parser. With no
// model up, a typed "I can't breathe" in such a language can go unread, so every question
// carries one extra line: call 911 for chest pain or trouble breathing.
const needsSafetyNet = (lang) => !hasNative(lang) && !llm.enabled();
function withSafetyNet(p, r) {
  const L = langOf(p);
  if (!needsSafetyNet(L)) return r;
  return { ...r, text: `${r.text}\n\n${t(L, 'safety_net_911')}`, textEn: `${r.textEn}\n\n${t('en', 'safety_net_911')}` };
}

const prompt = (p, stepId) => withSafetyNet(p, question(p, stepId));

function question(p, stepId) {
  const L = langOf(p);
  switch (stepId) {
    case 'weight':
      // No scale / too weak to stand on it: a way past the question, so the check-in can finish.
      return reply(p, 'ask_weight', {}, [[btn(L, 'weight_skip', 'ci:wt:skip')]]);
    case 'breath':
      return reply(p, 'ask_breath', {}, [
        [btn(L, 'breath_normal', 'ci:breath:normal')],
        [btn(L, 'breath_exertion', 'ci:breath:exertion')],
        [btn(L, 'breath_rest', 'ci:breath:rest')],
      ]);
    case 'orthopnea':
      // Two separate answers: needing extra pillows (orthopnea) vs waking up breathless (PND).
      return reply(p, 'ask_orthopnea', {}, [
        [btn(L, 'orth_pillows', 'ci:orth:pillows')],
        [btn(L, 'orth_pnd', 'ci:orth:pnd')],
        [btn(L, 'orth_none', 'ci:orth:no')],
      ]);
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
      return reply(p, 'ask_diuretic', { med: diureticName(p) }, [
        [btn(L, 'diu_taken', 'ci:diu:yes')],
        [btn(L, 'diu_later', 'ci:diu:later')],
        [btn(L, 'diu_missed', 'ci:diu:no')],
      ]);
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
  const confirm = reply(p, key, { diff, last, lb: a.weightPending }, [
    [{ label: t(L, 'weight_confirm_yes', { lb: a.weightPending }), data: 'ci:wconf:yes' }],
    [{ label: t(L, 'weight_confirm_no'), data: 'ci:wconf:no' }],
  ]);
  return withSafetyNet(p, confirm);
}

function applyButton(a, data) {
  const [, field, value] = data.split(':');
  switch (field) {
    case 'wconf':
      if (value === 'yes' && a.weightPending != null) confirmWeight(a);
      else delete a.weightPending;
      break;
    case 'wt':
      if (value === 'skip') {
        a.weightSkipped = true;
        delete a.weightPending;
      }
      break;
    case 'breath': a.breath = value; break;
    case 'orth':
      if (value === 'pnd') a.pnd = true;
      else a.orthopnea = value === 'yes' || value === 'pillows'; // 'yes' = older buttons still in chats
      break;
    case 'swell': a.swelling = value; break;
    case 'diu':
      if (value === 'later') a.diureticAsked = true;
      else a.diureticTaken = value === 'yes';
      break;
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

// -> { understood, textEn, trace } where trace is what the Judge debug drawer shows:
// the raw message, what the rules read, what the LLM extracted (+ evidence it quoted, and
// anything the validator dropped), and the answers after both.
async function applyText(a, text, step, lang) {
  const before = JSON.stringify(a);
  const snapshot = { ...a };

  // A weight volunteered before it was asked ("172 lbs, nothing scary" at the first question):
  // keep it. Past the first step only a number with a weight unit counts.
  if (step !== 'weight' && step !== 'spo2' && step !== 'diuretic' && a.weightLb == null && a.weightPending == null && (step === 'redflags' || /\b(?:lbs?|pounds?|libras?|kg|kilos?)\b/i.test(text))) {
    const early = parser.parseWeight(text);
    if (early) a.weightLb = early;
  }

  // Step-specific parsing first (numbers and yes/no only make sense in context).
  if (step === 'weight') {
    const lb = parser.parseWeight(text);
    if (!lb && parser.isNoScale(text)) {
      a.weightSkipped = true;
      delete a.weightPending;
    } else if (lb) {
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
    else if (parser.isLater(text)) a.diureticAsked = true;
    else if (parser.isNo(text)) a.diureticTaken = false;
  } else if (step === 'orthopnea') {
    // "nah slept fine on my usual 2 pillows" is a no; "yes, 3 extra pillows" is caught below.
    if (parser.isBaselineSleep(text)) a.orthopnea = false;
    else if (parser.isYes(text)) a.orthopnea = true;
  } else if (step === 'redflags' && (parser.isNo(text) || NONE_OF_THESE.test(text))) {
    a.redflagsAsked = true;
  }

  // Then anything else the message mentions, regardless of step.
  const extra = parser.parseFreeText(text);
  for (const [k, v] of Object.entries(extra)) if (a[k] == null) a[k] = v;
  if (extra.chestPain || extra.confusion || extra.fainting || extra.otherEmergency) a.redflagsAsked = true;
  const rules = diff(snapshot, a);

  // The LLM reads what the rules couldn't: anything in en/es the rules understood nothing of,
  // and anything richer than a bare answer in other languages (keyword lists only cover en/es,
  // so "152, mắt cá chân sưng hơn" must still yield the swelling). When the rules already
  // understood an en/es message the patient doesn't wait on a model (latency was the #1 demo
  // complaint). It only fills fields the rules left empty; it never overrides them.
  // Hard 4 s deadline (parser.PARSE_DEADLINE_MS): past it the patient gets the rules' reading
  // and the buttons, never a frozen chat.
  let textEn = null;
  let llmTrace = null;
  const bareAnswer = /^\s*([\d.,]+\s*(lb|lbs|pounds|libras|kg|%)?|y|yes|no|n|si|sí|ok)\s*$/i.test(text);
  if ((JSON.stringify(a) === before || (!hasNative(lang) && !bareAnswer)) && llm.enabled()) {
    const traced = await parser.parseWithLLMTraced(text, { step });
    const c = traced.result;
    llmTrace = { fields: traced.raw?.fields ?? null, dropped: traced.dropped, unverified: traced.unverified, timedOut: traced.timedOut, ms: traced.ms };
    if (c) {
      textEn = c.textEn ?? null;
      if (c.weightLb && a.weightLb == null && !a.weightSkipped) {
        a.weightLb = c.weightLb;
        delete a.weightPending; // a newly typed weight replaces the one awaiting confirmation
      }
      for (const k of ['breath', 'orthopnea', 'pnd', 'swelling', 'chestPain', 'dizzy', 'confusion', 'fainting']) {
        if (c[k] != null && a[k] == null) a[k] = c[k];
      }
      // "Not yet" already answered the pill question; the model can't turn it into a miss.
      if (c.diureticTaken != null && a.diureticTaken == null && !a.diureticAsked) a.diureticTaken = c.diureticTaken;
      if (c.spo2 != null && a.spo2 == null) { a.spo2 = c.spo2; a.spo2Asked = true; }
      if (c.chestPain || c.confusion || c.fainting) a.redflagsAsked = true;
      // "No chest pain, no fainting" in a language the keyword lists don't cover comes back as
      // false / false: that IS the answer to the red-flag question (the check-in used to sit on it forever).
      if (step === 'redflags' && ['chestPain', 'confusion', 'fainting', 'dizzy'].some((k) => c[k] === false)) a.redflagsAsked = true;
    }
  }
  // Model down or silent: a plain "no" in vi / hi / zh / ko / ar... with nothing alarming found is still a no.
  if (step === 'redflags' && !a.redflagsAsked && !isEmergency(a) && !hasNative(lang) && INTL_NO.test(text)) a.redflagsAsked = true;
  const trace = { text, step, rules, llm: llmTrace, answers: { ...a } };
  return { understood: JSON.stringify(a) !== before, textEn, trace };
}

// Fields that changed between two answer snapshots (what one parser contributed).
function diff(from, to) {
  return Object.fromEntries(Object.entries(to).filter(([k, v]) => JSON.stringify(from[k]) !== JSON.stringify(v)));
}

// A leading "no" in the languages with their own red-flag lists (and a few without): không / ko, नहीं, 没有, 아니, لا, não, hindi, non.
const INTL_NO = /^\s*(?:không|khong|ko|नहीं|नही|नहि|कोई नहीं|没有|没|不|无|沒有|아니(?:요|오)?|없(?:어요|습니다)|لا|ليس|não|nao|hindi|wala|non|nan)(?![\p{L}])/iu;
const NONE_OF_THESE = /\b(none|nothing|neither|all good|ninguno|ninguna|nada)\b/i;

// Two replies sent as one bubble (an acknowledgement + the next question).
const combine = (first, second) => ({
  ...second,
  text: `${first.text}
${second.text}`,
  textEn: `${first.textEn}
${second.textEn}`,
});

// Only the fields the emergency rule reads; anything else the LLM returns is ignored here.
const pickEmergencyFields = (c) => ({
  ...(c.chestPain === true && { chestPain: true }),
  ...(c.confusion === true && { confusion: true }),
  ...(c.fainting === true && { fainting: true }),
  ...(c.unresponsive === true && { otherEmergency: 'unresponsive' }),
  ...(c.breath === 'rest' && { breath: 'rest' }),
  ...(typeof c.spo2 === 'number' && { spo2: c.spo2 }),
});

const copdOf = (patient) => !!patient?.profile?.copd;
const isEmergency = (a, copd = false) =>
  a.chestPain || a.breath === 'rest' || a.confusion || a.fainting || a.otherEmergency || (a.spo2 != null && a.spo2 < spo2Thresholds(copd).red);

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
  let trace = null;
  const replies = [];

  if (buttonData?.startsWith('ci:')) {
    const snapshot = { ...a };
    applyButton(a, buttonData);
    trace = { button: buttonData, step: state.state, rules: diff(snapshot, a), llm: null, answers: { ...a } };
  } else if (text) {
    ({ understood, textEn, trace } = await applyText(a, text, state.state, langOf(patient)));
    // "Can I skip my water pill?" mid-check-in: the nurse gets it (never answered here),
    // then the check-in carries on.
    if (companion.DOSING_CHANGE.test(text)) {
      replies.push(...(await companion.answer(patient, text)).replies);
      understood = true;
    }
  }
  holdImplausibleWeight(patient, a);
  const traced = trace && store.audit('parse_trace', patient.id, { ...trace, reporter: state.reporter ?? 'patient' });

  // Emergencies never wait for a weight confirmation.
  if (isEmergency(a, copdOf(patient))) return { replies: await finish(patient, a, traced), textEn };

  const next = steps.find((s) => !s.done(a));
  if (!next) return { replies: [...replies, ...(await finish(patient, a, traced))], textEn };

  store.updatePatient(patient.id, { checkin: { ...state, state: next.id, answers: a } });
  const sameStep = next.id === state.state;
  if (next.id === 'weight' && a.weightPending != null) replies.push(weightConfirmPrompt(patient, a));
  else if (!understood && next.id === 'weight') replies.push(withSafetyNet(patient, reply(patient, 'bad_weight', {}, [[btn(langOf(patient), 'weight_skip', 'ci:wt:skip')]])));
  // Never re-send the identical question: say we noted what they told us, or that we
  // didn't catch it (and point at the buttons).
  else if (!understood) replies.push(combine(reply(patient, 'didnt_catch'), prompt(patient, next.id)));
  else if (sameStep && text && !replies.length) replies.push(combine(reply(patient, 'noted'), prompt(patient, next.id)));
  else replies.push(prompt(patient, next.id));
  return { replies, textEn };
}

async function finish(patient, a, traced = null) {
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

  const result = triage({ weights, answers: a, missedDiureticDays: consecutiveMissedDiureticDays(doses), dryWeightLb: patient.dryWeightLb, copd: copdOf(patient) });
  if (traced) {
    // The debug drawer's third pane: which deterministic rules fired on the final answers.
    traced.data.outcome = { tier: result.tier, flags: result.flags.map((x) => ({ code: x.code, tier: x.tier, text: x.text })) };
    store.persist('audit', traced);
  }
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

// A photo while we're waiting for the weight: read the scale (vision model) and ALWAYS ask
// the patient to confirm the reading. Returns replies, or null when a photo isn't expected
// here (the caller then treats it as a regular photo for the care team).
export async function handlePhoto(patient, photo) {
  if (!isActive(patient) || patient.checkin.state !== 'weight') return null;
  const read = await parser.readScalePhoto(photo);
  store.audit('scale_photo', patient.id, read ? { lb: read.lb, display: read.display, unit: read.unit } : { readable: false });
  if (!read) return [reply(patient, 'scale_unreadable')];
  const a = { ...patient.checkin.answers, weightPending: read.lb };
  delete a.weightLb;
  store.updatePatient(patient.id, { checkin: { ...patient.checkin, answers: a } });
  const L = langOf(patient);
  const confirm = reply(patient, 'scale_read', { lb: read.lb }, [
    [{ label: t(L, 'weight_confirm_yes', { lb: read.lb }), data: 'ci:wconf:yes' }],
    [{ label: t(L, 'weight_confirm_no'), data: 'ci:wconf:no' }],
  ]);
  return [withSafetyNet(patient, confirm)];
}

// Emergency phrase outside a check-in ("my chest hurts"): triage + escalate right away.
// A caregiver can report one too ("mom has chest pain"): same triage, reply addressed to them.
// Second opinion (audit 2026-10-11 S4): the rules read en/es/vi/hi/zh, but fresh phrasings slipped
// past them (14 of 50) and ko / ar / pt / tl / ht have no rules at all. So whenever the rules find
// nothing and a healthy model is up, the LLM *parses* the message and the same isEmergency rule
// decides. It can only add an emergency, never remove one, and it never picks the tier. Questions
// and "if I ..." sentences skip it (a 7B model reads "what should I do if I have chest pain?" as a
// symptom report); the rules already handle those.
const HYPOTHETICAL = /\?|^\s*(?:what|when|how|why|can|could|should|is|are|do|does|will|que|qué|cómo|como|cuándo|puedo)\b|\b(?:if|in case|si)\b/i;
export async function handleUrgentFreeText(patient, text, { reporter = 'patient', lang } = {}) {
  let extra = parser.parseFreeText(text);
  const msgLang = lang ?? patient.language;
  const copd = copdOf(patient);
  const askModel = !isEmergency(extra, copd) && llm.enabled() && String(text).trim().length >= 3 && (!hasNative(msgLang) || !HYPOTHETICAL.test(text));
  if (askModel) {
    const c = await parser.parseWithLLM(text);
    if (c) {
      extra = { ...extra, ...pickEmergencyFields(c) };
      if (isEmergency(extra, copd)) store.audit('llm_parse', patient.id, { purpose: 'unprompted_emergency', lang: msgLang, flags: pickEmergencyFields(c) });
    }
  }
  if (!isEmergency(extra, copd)) return null;
  const result = triage({ weights: patient.weights, answers: extra, dryWeightLb: patient.dryWeightLb, copd });
  store.updatePatient(patient.id, { lastTier: result.tier });
  const proxy = reporter === 'caregiver';
  await escalate(store.getPatient(patient.id), result, { source: proxy ? 'caregiver message' : 'unprompted message', reporter });
  const key = proxy ? 'proxy_red_911' : 'red_interrupt';
  return [{ ...replyIn(lang ?? patient.language, key, { name: firstName(patient) }), urgent: true }];
}

// A blood pressure the patient typed ("118/72") outside a check-in: save it, run it through the
// same rules as everything else, and escalate if it is out of range. -> Reply[]
export async function handleBloodPressure(patient, bp) {
  store.updatePatient(patient.id, { vitals: [...(patient.vitals ?? []), { ts: clock.nowISO(), ...bp, source: 'self' }] });
  store.audit('vital_reported', patient.id, bp);
  const result = triage({ weights: [], answers: {}, bp }); // BP only: weight trends are the check-in's job
  const vars = { bp: `${bp.sbp}/${bp.dbp}` };
  if (result.tier === 'GREEN') return [{ text: t(patient.language, 'bp_logged', vars), textEn: t('en', 'bp_logged', vars) }];
  store.updatePatient(patient.id, { lastTier: result.tier });
  await escalate(store.getPatient(patient.id), result, { source: 'blood pressure' });
  if (result.tier === 'RED') return [{ ...replyIn(patient.language, 'red_interrupt', { name: firstName(patient) }), urgent: true }];
  return [{ text: t(patient.language, 'bp_flagged', vars), textEn: t('en', 'bp_flagged', vars) }];
}

// A check-in button from an old message, tapped when no check-in is running. Returns urgent
// replies if the tap itself is an emergency (chest pain, fainted, confused, breathless at rest),
// else null so the caller offers a fresh check-in.
export async function handleStaleTap(patient, data) {
  const a = {};
  applyButton(a, data);
  const copd = copdOf(patient);
  if (!isEmergency(a, copd)) return null;
  const result = triage({ weights: patient.weights, answers: a, dryWeightLb: patient.dryWeightLb, copd });
  store.updatePatient(patient.id, { lastTier: result.tier });
  store.audit('stale_tap_emergency', patient.id, { data });
  await escalate(store.getPatient(patient.id), result, { source: 'old button tap' });
  return [{ ...replyIn(patient.language, 'red_interrupt', { name: firstName(patient) }), urgent: true }];
}
