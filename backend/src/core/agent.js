// ============================================================================
// THE CONTRACT between any messaging channel (Telegram today) and the core logic.
//
//   handleInbound({ patientId, text?, buttonData?, voiceTranscript? })
//     -> Promise<Reply[]>
//
//   Reply = { text: string, buttons?: Button[][], textEn?: string }   // rows of buttons
//   Button = { label: string, data: string }         // data comes back as buttonData (<= 64 bytes)
//
// The channel layer only has to: identify the patient, call this, and render
// the replies (text + buttons; ignore textEn). It never makes clinical decisions.
// ============================================================================
import * as store from '../store.js';
import * as checkin from './checkin.js';
import { t, localize, toEnglish, hasNative } from './i18n.js';

const START_WORDS = /^\/?(check-?in|start|chequeo|empezar|hola|hi|hello)\b/i;

export async function handleInbound({ patientId, text, buttonData, voiceTranscript }) {
  const patient = store.getPatient(patientId);
  if (!patient) return [{ text: 'Sorry, I could not find your record. Ask your care team for your link code.' }];

  const input = voiceTranscript ?? text;
  const inbound = store.addMessage({ patientId, direction: 'in', text: input ?? buttonLabel(patientId, buttonData) });

  let replies;
  let textEn = null;

  if (buttonData === 'cmd:checkin') {
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
  for (const r of replies) store.addMessage({ patientId, direction: 'out', text: r.text, textEn: r.textEn, buttons: r.buttons });
  return replies;
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

// Languages without built-in strings (vi, hi, ...) get translated by Claude; en/es pass through.
async function localizeReply(patient, r) {
  if (hasNative(patient.language)) return r;
  const text = await localize(patient.language, r.text);
  const buttons = r.buttons
    ? await Promise.all(r.buttons.map((row) => Promise.all(row.map(async (b) => ({ ...b, label: await localize(patient.language, b.label) })))))
    : undefined;
  return { ...r, text, textEn: r.textEn ?? r.text, ...(buttons && { buttons }) };
}
