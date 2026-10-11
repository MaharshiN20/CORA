// ============================================================================
// THE CONTRACT between any messaging channel (Telegram, SMS, WhatsApp, dashboard
// simulator) and the core logic. Full spec: docs/CONTRACTS.md.
//
//   handleInbound({
//     patientId,                          // required, resolve via store.findByChatId
//     role?: 'patient' | 'caregiver',     // default 'patient'
//     channel?: 'telegram'|'sms'|'whatsapp'|'sim',
//     text?, buttonData?, voiceTranscript?,
//     photo?: { base64: string, mime: string },
//   }) -> Promise<Reply[]>
//
//   Reply  = { text, buttons?: Button[][], textEn?, urgent?: boolean, voice?: boolean }
//   Button = { label, data }              // data comes back as buttonData (<= 64 bytes)
//
//   urgent: render as an emergency (bold / alert styling).
//   voice:  patient prefers audio: also send a TTS voice note of `text`.
//
// The channel layer only has to: identify the patient, call this, and render the
// replies (text + buttons, honour urgent/voice; ignore textEn). No clinical logic.
// ============================================================================
import * as store from '../store.js';
import { INJECTION } from './injection.js';
import * as checkin from './checkin.js';
import * as meds from './meds.js';
import * as pharmacy from './pharmacy.js';
import * as outreach from './outreach.js';
import * as companion from './companion.js';
import * as lessons from './lessons.js';
import * as sdoh from './sdoh.js';
import * as parser from './parser.js';
import * as llm from './llm/index.js';
import * as clock from './clock.js';
import { redLock, appendToRedAlert } from './escalation.js';
import { t, localize, localizeUrgent, toEnglish, hasNative } from './i18n.js';

const PURE_QUESTION = /^\s*(?:what|how|when|why|should|can|could|is|are|do|does|qu[eé]|c[oó]mo|cu[aá]ndo|puedo|debo)\b[^.]*\?\s*$/i;
const START_WORDS = /^\/?(check[- ]?in|start|chequeo|empezar|hola|hi|hello)\b/i;
// Caregivers must ask explicitly (or tap the button): a "hi" shouldn't start a proxy check-in.
const PROXY_WORDS = /^\/?(check[- ]?in|chequeo)\b/i;
// Messages that try to re-program the bot: deterministic, audited, and never shown to an LLM as
// instructions; symptoms in the same message still count ("SYSTEM OVERRIDE ... btw I passed out").
// The patterns (and the cut that keeps them away from the model) live in core/injection.js.
export { INJECTION };

// Background English translations of inbound messages (tests / e2e can wait for them).
const pendingTranslations = new Set();
export async function flushTranslations() {
  while (pendingTranslations.size) await Promise.all([...pendingTranslations]);
}

// ---------- one thing at a time per patient ----------
// A check-in is a read-modify-write over the patient record with awaits in the middle (LLM
// parsing, escalation sends). Two messages arriving together (a double tap, a Twilio retry, a
// caregiver and a patient at once) would both read the same state and both finish the check-in:
// two weights, two alerts, two nurse pages, or a finished check-in resurrected. So work for the
// same patient runs strictly in arrival order; different patients stay fully parallel.
const lanes = new Map();
export function withPatientLock(patientId, fn) {
  const prev = lanes.get(patientId) ?? Promise.resolve();
  const run = prev.then(fn, fn); // a failure upstream never blocks the next message
  const tail = run.catch(() => {});
  lanes.set(patientId, tail);
  tail.then(() => lanes.get(patientId) === tail && lanes.delete(patientId));
  return run;
}

// ---------- duplicate deliveries ----------
// Channels that retry (Twilio re-posts when we are slow) pass the provider's message id; a repeat
// gets the first call's replies back instead of being processed twice.
const DEDUP_TTL_MS = 10 * 60_000;
const seen = new Map();
export const resetInboundDedup = () => seen.clear();

// Whatever goes wrong inside a handler (a model answering in a shape nobody expected, a bug), the patient
// still gets a reply that says what to do in an emergency, instead of silence or a 500 (audit 2026-10-11).
function guarded(msg) {
  return processInbound(msg).catch((err) => {
    console.error(`[agent] handler failed for ${msg.patientId}: ${err?.stack ?? err}`);
    store.audit('handler_error', msg.patientId, { error: String(err?.message ?? err).slice(0, 200) });
    const lang = hasNative(store.getPatient(msg.patientId)?.language) ? store.getPatient(msg.patientId).language : 'en';
    return [{ text: `${t(lang, 'didnt_catch')}

${t(lang, 'safety_net_911')}`, textEn: `${t('en', 'didnt_catch')}

${t('en', 'safety_net_911')}` }];
  });
}

export function handleInbound(msg) {
  const { patientId, channel, messageId } = msg;
  if (messageId == null) return withPatientLock(patientId, () => guarded(msg));
  const key = `${channel}:${patientId}:${messageId}`;
  const t = performance.now(); // monotonic: pacing, not domain time
  const hit = seen.get(key);
  if (hit && t - hit.at < DEDUP_TTL_MS) return hit.promise;
  if (seen.size > 2000) for (const [k, v] of seen) if (t - v.at >= DEDUP_TTL_MS) seen.delete(k);
  const promise = withPatientLock(patientId, () => guarded(msg));
  seen.set(key, { at: t, promise });
  return promise;
}

const MAX_TEXT = 4000;

async function processInbound({ patientId, role = 'patient', channel, text, buttonData, voiceTranscript, photo }) {
  const patient = store.getPatient(patientId);
  if (!patient) return [{ text: t('en', 'record_not_found') }];

  // Whatever a channel hands over is text of a sane size: a 100 KB "message" used to reach the model and
  // blow its context (audit 2026-10-11). Telegram's own limit is 4096 characters.
  const clean = (v) => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : undefined);
  const input = clean(voiceTranscript) ?? clean(text);
  const shown = photo ? '[photo]' : input ?? buttonLabel(patientId, buttonData);
  const inbound = store.addMessage({ patientId, direction: 'in', from: role, to: role, text: shown, channel });

  let replies;
  let textEn = null;

  // Any sign of life from the patient stops the non-response ladder.
  if (role === 'patient') outreach.onPatientReply(patient);

  const injection = !!input && INJECTION.test(input);
  if (injection) store.audit('injection_attempt', patientId, { role, text: input.slice(0, 300) });

  const lock = redLock(patient);
  if (lock) {
    // Told to call 911 within the hour: re-assert it, whatever they sent, and add it to the
    // RED incident ("should I take an extra Lasix instead?" is part of the emergency).
    replies = await redLockReplies(patient, lock, { role, text: photo ? '[photo]' : input ?? buttonLabel(patientId, buttonData) });
  } else if (role === 'caregiver') {
    ({ replies, textEn } = await handleCaregiver(patient, { input, buttonData, injection }));
  } else if (photo) {
    // Waiting for the weight: read the scale (confirmed by the patient). Otherwise it's a
    // photo for the care team. TODO(core P3-13): med-bottle reconciliation.
    replies = await checkin.handlePhoto(patient, photo);
    if (!replies) {
      store.audit('photo_received', patientId, { mime: photo.mime, bytes: Math.round((photo.base64?.length ?? 0) * 0.75) });
      replies = [{ text: t(patient.language, 'photo_received'), textEn: t('en', 'photo_received') }];
    }
  } else if (buttonData?.startsWith('med:')) {
    // Medication confirmations work any time, even in the middle of a check-in.
    replies = meds.handleButton(patient, buttonData);
  } else if (buttonData?.startsWith('rx:')) {
    replies = pharmacy.handleButton(patient, buttonData);
  } else if (buttonData?.startsWith('lesson:')) {
    replies = lessons.handleButton(patient, buttonData);
  } else if (buttonData?.startsWith('sdoh:')) {
    replies = await sdoh.handleButton(patient, buttonData);
  } else if (buttonData === 'cmd:checkin') {
    replies = checkin.start(patient);
  } else if (checkin.isActive(patient)) {
    ({ replies, textEn } = await checkin.handle(patient, { text: input, buttonData }));
  } else if (buttonData?.startsWith('ci:')) {
    // A check-in button from an old message, tapped with no check-in running. Most are just
    // stale (offer a fresh check-in), but "chest pain" / "can't breathe" never are.
    replies = (await checkin.handleStaleTap(patient, buttonData)) ?? offerCheckin(patient);
  } else if (input) {
    ({ replies, textEn } = await handleFreeText(patient, input, { injection }));
  } else {
    replies = offerCheckin(patient);
  }

  // Replies (and the sender's text) are in the sender's language: caregiver or patient.
  const lang = role === 'caregiver' ? patient.caregiver?.language ?? 'en' : patient.language;

  // English copy of what they said, for the dashboard. Only the nurse needs it, so it's
  // filled in the background (the dashboard updates live) instead of making the patient
  // wait seconds for an AI translation before their next question.
  if (input && lang !== 'en') {
    if (textEn) store.updateMessage(inbound.id, { textEn });
    else {
      const job = toEnglish(lang, input)
        .then((en) => en && store.updateMessage(inbound.id, { textEn: en }))
        .catch(() => {})
        .finally(() => pendingTranslations.delete(job));
      pendingTranslations.add(job);
    }
  }

  replies = await Promise.all(replies.map((r) => localizeReply(lang, r)));
  if (patient.voiceMode && role === 'patient') replies = replies.map((r) => ({ ...r, voice: true }));
  const to = role === 'caregiver' ? 'caregiver' : 'patient';
  for (const r of replies) store.addMessage({ patientId, direction: 'out', to, text: r.text, textEn: r.textEn, buttons: r.buttons, channel });
  return replies;
}

// Patient free text outside a check-in, in safety order:
// emergency -> start words -> medication-change question -> volunteered symptom
// (pre-filled check-in) -> question (discharge companion) -> offer a check-in.
async function handleFreeText(patient, input, { injection = false } = {}) {
  const urgent = await checkin.handleUrgentFreeText(patient, input);
  if (urgent) return { replies: urgent };
  // "hola" starts a check-in; "hola, mis tobillos están hinchados" must keep the swelling (below).
  if (START_WORDS.test(input.trim()) && !Object.keys(parser.parseFreeText(input)).length) return { replies: checkin.start(patient) };
  if (companion.DOSING_CHANGE.test(input)) return { replies: (await companion.answer(patient, input)).replies };
  // "118/72": a blood pressure (e.g. the nurse asked for it before a standing order).
  const bp = parser.parseBloodPressure(input);
  if (bp) return { replies: await checkin.handleBloodPressure(patient, bp) };
  // "What should I do when I feel short of breath walking?" asks about a symptom, it doesn't report one:
  // a message that opens with a question word and matches the patient's own instructions is answered.
  if (PURE_QUESTION.test(input) && companion.matchSection(patient, input)) return { replies: (await companion.answer(patient, input)).replies };
  if (Object.keys(parser.parseFreeText(input)).length) return checkin.startWith(patient, input);
  // A re-programming attempt with no symptom or medicine question: a safe canned reply, no LLM.
  if (injection) return { replies: [{ text: t(patient.language, 'companion_other'), textEn: t('en', 'companion_other') }] };
  if (companion.looksLikeQuestion(input) || llm.enabled()) {
    const res = await companion.answer(patient, input);
    if (res.kind === 'symptom') return checkin.startWith(patient, input);
    if (res.kind === 'other' && !companion.looksLikeQuestion(input)) return { replies: offerCheckin(patient) }; // "thanks!"
    return { replies: res.replies };
  }
  return { replies: offerCheckin(patient) };
}

function caregiverAck(patient, lang) {
  const name = patient.name.split(' ')[0];
  return { text: t(lang, 'caregiver_ack', { name }), textEn: t('en', 'caregiver_ack', { name }) };
}

// Everything that arrives while the RED lock holds: 911 again (in the sender's language), and
// the message goes onto the RED alert instead of starting anything new.
async function redLockReplies(patient, alert, { role, text }) {
  const caregiver = role === 'caregiver';
  const lang = caregiver ? patient.caregiver?.language ?? 'en' : patient.language;
  const L = hasNative(lang) ? lang : 'en';
  const note = text && companion.DOSING_CHANGE.test(text) ? 'asks about changing a medicine instead of calling 911' : null;
  const who = caregiver ? `Caregiver ${patient.caregiver?.name ?? ''}`.trim() : 'Patient';
  await appendToRedAlert(patient, alert, { who, text, note });
  const key = caregiver ? 'proxy_red_lock' : 'red_lock';
  const name = patient.name.split(' ')[0];
  return [{ text: t(L, key, { name }), textEn: t('en', key, { name }), urgent: true }];
}

// Caregiver messages (P1-7): answer the check-in for the patient (proxy), report an
// emergency on their behalf, ask the nurse about a medicine, ask a question, or just
// get acknowledged. Nothing a caregiver says is silently dropped.
async function handleCaregiver(patient, { input, buttonData, injection = false }) {
  const cgLang = patient.caregiver?.language ?? 'en';
  const name = patient.name.split(' ')[0];
  const wantsProxy = buttonData === 'cmd:proxy' || (input && PROXY_WORDS.test(input.trim()));

  if (wantsProxy) {
    if (patient.caregiverConsent === false) {
      return { replies: [{ text: t(cgLang, 'proxy_not_enabled', { name }), textEn: t('en', 'proxy_not_enabled', { name }) }] };
    }
    outreach.onPatientReply(patient, { via: 'caregiver' }); // someone answered: stop the ladder
    return { replies: checkin.start(patient, { reporter: 'caregiver', lang: cgLang }) };
  }
  if (checkin.reporterOf(patient) === 'caregiver' && (input || buttonData?.startsWith('ci:'))) {
    return checkin.handle(patient, { text: input, buttonData });
  }
  if (input) {
    const urgent = await checkin.handleUrgentFreeText(patient, input, { reporter: 'caregiver', lang: cgLang });
    if (urgent) return { replies: urgent };
    // "Can I stop her carvedilol? It makes her tired": always to the nurse.
    if (companion.DOSING_CHANGE.test(input)) return { replies: (await companion.answer(patient, input, { lang: cgLang, reporter: 'caregiver' })).replies };
    if (!injection && companion.looksLikeQuestion(input)) {
      const res = await companion.answer(patient, input, { lang: cgLang, reporter: 'caregiver' });
      if (['answer', 'nurse', 'dosing'].includes(res.kind)) return { replies: res.replies };
    }
  }
  return { replies: [caregiverAck(patient, hasNative(cgLang) ? cgLang : 'en')] };
}

// Called by the scheduler / dashboard to start a check-in proactively.
// Returns the first prompt(s); the caller sends them via channels.sendToPatient().
export function startCheckin(patientId) {
  return withPatientLock(patientId, async () => {
    const patient = store.getPatient(patientId);
    if (!patient) return [];
    return Promise.all(checkin.start(patient).map((r) => localizeReply(patient.language, r)));
  });
}

// Show what the patient tapped ("😊 Normal") rather than the raw callback data.
function buttonLabel(patientId, data) {
  const msgs = store.listMessages(patientId);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const b = msgs[i].buttons?.flat().find((x) => x.data === data);
    if (b) return b.label;
  }
  return `[${data}]`;
}

function offerCheckin(patient) {
  return [
    {
      text: t(patient.language, 'not_in_checkin', { name: patient.name.split(' ')[0] }),
      textEn: t('en', 'not_in_checkin', { name: patient.name.split(' ')[0] }),
      buttons: [[{ label: t(patient.language, 'start_checkin'), data: 'cmd:checkin' }]],
    },
  ];
}

// Languages without built-in strings (vi, hi, ...) get translated by the LLM chain; en/es pass through.
async function localizeReply(lang, r) {
  // "Call 911" never waits on a slow model and is never garbled into something without 911.
  if (r.urgent && !r.localized && !hasNative(lang)) return { ...r, text: await localizeUrgent(lang, r.text), textEn: r.textEn ?? r.text };
  if (r.localized) {
    // Already written in the patient's language (e.g. a companion answer from the LLM).
    const { localized, ...rest } = r;
    return rest;
  }
  if (hasNative(lang)) return r;
  const text = await localize(lang, r.text);
  const buttons = r.buttons
    ? await Promise.all(r.buttons.map((row) => Promise.all(row.map(async (b) => ({ ...b, label: await localize(lang, b.label) })))))
    : undefined;
  return { ...r, text, textEn: r.textEn ?? r.text, ...(buttons && { buttons }) };
}
