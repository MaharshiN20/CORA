// Outbound routing. Core code calls these and doesn't care which channel is live.
// If Telegram isn't configured or the person hasn't pressed Start yet, the
// message still lands in the dashboard log so the demo never silently drops it.
import * as store from '../store.js';
import * as telegram from './telegram.js';

async function deliver(chatId, msg, opts) {
  if (!chatId || !telegram.isEnabled()) return false;
  try {
    await telegram.sendToChat(chatId, msg, opts);
    return true;
  } catch (err) {
    console.error('[channels] telegram send failed:', err.message);
    return false;
  }
}

export async function sendToPatient(patient, msg) {
  store.addMessage({ patientId: patient.id, direction: 'out', to: 'patient', text: msg.text, textEn: msg.textEn, buttons: msg.buttons });
  // Proactive messages (check-ins, reminders) honour voice mode too, not just replies.
  const voice = msg.voice ?? Boolean(patient.voiceMode);
  return deliver(patient.chatId, { ...msg, voice }, { language: patient.language });
}

export async function sendToCaregiver(patient, msg) {
  store.addMessage({ patientId: patient.id, direction: 'out', to: 'caregiver', text: msg.text, textEn: msg.textEn, buttons: msg.buttons });
  return deliver(patient.caregiver?.chatId, msg, { language: patient.caregiver?.language });
}

// Nurse messages aren't about one patient in general; when they are (msg.patientId), log them there too.
export async function sendToNurses(msg) {
  if (msg.patientId) store.addMessage({ patientId: msg.patientId, direction: 'out', to: 'nurse', text: msg.text, textEn: msg.textEn, buttons: msg.buttons });
  return deliver(process.env.NURSE_CHAT_ID, msg);
}
