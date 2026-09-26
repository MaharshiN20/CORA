// Outbound routing. Core code calls these and doesn't care which channel is live.
// If Telegram isn't configured or the person hasn't pressed Start yet, the
// message still lands in the dashboard log so the demo never silently drops it.
import * as store from '../store.js';
import * as telegram from './telegram.js';

async function deliver(chatId, msg) {
  if (!chatId || !telegram.isEnabled()) return false;
  try {
    await telegram.sendToChat(chatId, msg);
    return true;
  } catch (err) {
    console.error('[channels] telegram send failed:', err.message);
    return false;
  }
}

export async function sendToPatient(patient, msg) {
  store.addMessage({ patientId: patient.id, direction: 'out', to: 'patient', text: msg.text });
  return deliver(patient.chatId, msg);
}

export async function sendToCaregiver(patient, msg) {
  store.addMessage({ patientId: patient.id, direction: 'out', to: 'caregiver', text: msg.text });
  return deliver(patient.caregiver?.chatId, msg);
}

export async function sendToNurses(msg) {
  return deliver(process.env.NURSE_CHAT_ID, msg);
}
