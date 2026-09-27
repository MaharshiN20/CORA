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
import * as checkin from './checkin.js';
import * as meds from './meds.js';
import * as pharmacy from './pharmacy.js';
import * as outreach from './outreach.js';
import { t, localize, toEnglish, hasNative } from './i18n.js';

const START_WORDS = /^\/?(check-?in|start|chequeo|empezar|hola|hi|hello)\b/i;

export async function handleInbound({ patientId, role = 'patient', channel, text, buttonData, voiceTranscript, photo }) {
  const patient = store.getPatient(patientId);
  if (!patient) return [{ text: 'Sorry, I could not find your record. Ask your care team for your link code.' }];

  const input = voiceTranscript ?? text;
  const shown = photo ? '[photo]' : input ?? buttonLabel(patientId, buttonData);
  const inbound = store.addMessage({ patientId, direction: 'in', from: role, to: role, text: shown, channel });

  let replies;
  let textEn = null;

  // Any sign of life from the patient stops the non-response ladder.
  if (role === 'patient') outreach.onPatientReply(patient);

  if (role === 'caregiver') {
    // TODO(core P1-7): proxy check-in for the patient. Until then, acknowledge.
    replies = [caregiverAck(patient)];
  } else if (photo) {
    // TODO(core P3-13): med-bottle photo reconciliation via llm.completeVision.
    store.audit('photo_received', patientId, { mime: photo.mime, bytes: Math.round((photo.base64?.length ?? 0) * 0.75) });
    replies = [{ text: t(patient.language, 'photo_received'), textEn: t('en', 'photo_received') }];
  } else if (buttonData?.startsWith('med:')) {
    // Medication confirmations work any time, even in the middle of a check-in.
    replies = meds.handleButton(patient, buttonData);
  } else if (buttonData?.startsWith('rx:')) {
    replies = pharmacy.handleButton(patient, buttonData);
  } else if (buttonData === 'cmd:checkin') {
    replies = checkin.start(patient);
  } else if (checkin.isActive(patient)) {
    ({ replies, textEn } = await checkin.handle(patient, { text: input, buttonData }));
  } else if (input) {
    replies =
      (await checkin.handleUrgentFreeText(patient, input)) ??
      (START_WORDS.test(input.trim()) ? checkin.start(patient) : offerCheckin(patient));
  } else {
    replies = offerCheckin(patient);
  }

  // English copy of what the patient said, for the dashboard.
  if (input && patient.language !== 'en') {
    textEn ??= await toEnglish(patient.language, input);
    if (textEn) store.updateMessage(inbound.id, { textEn });
  }

  replies = await Promise.all(replies.map((r) => localizeReply(patient, r)));
  if (patient.voiceMode && role === 'patient') replies = replies.map((r) => ({ ...r, voice: true }));
  const to = role === 'caregiver' ? 'caregiver' : 'patient';
  for (const r of replies) store.addMessage({ patientId, direction: 'out', to, text: r.text, textEn: r.textEn, buttons: r.buttons, channel });
  return replies;
}

function caregiverAck(patient) {
  const first = patient.name.split(' ')[0];
  const text = `Thanks! You're connected as a caregiver for ${first}. You'll get alerts and a weekly summary here.`;
  return { text, textEn: text };
}

// Called by the scheduler / dashboard to start a check-in proactively.
// Returns the first prompt(s); the caller sends them via channels.sendToPatient().
export async function startCheckin(patientId) {
  const patient = store.getPatient(patientId);
  if (!patient) return [];
  return Promise.all(checkin.start(patient).map((r) => localizeReply(patient, r)));
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
async function localizeReply(patient, r) {
  if (hasNative(patient.language)) return r;
  const text = await localize(patient.language, r.text);
  const buttons = r.buttons
    ? await Promise.all(r.buttons.map((row) => Promise.all(row.map(async (b) => ({ ...b, label: await localize(patient.language, b.label) })))))
    : undefined;
  return { ...r, text, textEn: r.textEn ?? r.text, ...(buttons && { buttons }) };
}
