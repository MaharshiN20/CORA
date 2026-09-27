// Outbound routing. Core code calls these and doesn't care which channel is live.
// If no channel is configured or the person hasn't linked one yet, the message
// still lands in the dashboard log so the demo never silently drops it.
//
// Adapters: { name, isEnabled(), send(address, reply, opts) }. A person is reached on
// their preferred channel (patient.channel, default telegram); if that's disabled,
// unlinked or the send fails, any other enabled channel they have an address for.
import * as store from '../store.js';
import * as telegram from './telegram.js';
import * as twilio from './twilio.js';

// telegram.js imports the core, which imports this file: read its exports lazily (import cycle).
const DEFAULT_ADAPTERS = {
  telegram: { name: 'telegram', isEnabled: () => telegram.isEnabled(), send: (chatId, reply, opts) => telegram.sendToChat(chatId, reply, opts) },
  sms: twilio.sms,
  whatsapp: twilio.whatsapp,
};
let adapters = { ...DEFAULT_ADAPTERS };

export const listAdapters = () => Object.values(adapters);

// Test hooks: swap one adapter for a fake, then put the real ones back.
export function setAdapter(name, adapter) {
  adapters[name] = adapter;
}
export function resetAdapters() {
  adapters = { ...DEFAULT_ADAPTERS };
}

// Where each channel reaches this person. SMS and WhatsApp share the phone number.
const addressesOf = ({ chatId, phone }) => ({ telegram: chatId, sms: phone, whatsapp: phone });

async function route(person, preferred, reply, opts) {
  const addresses = addressesOf(person);
  const order = [...new Set([preferred || 'telegram', ...Object.keys(adapters)])];
  for (const name of order) {
    const adapter = adapters[name];
    const address = addresses[name];
    if (!adapter || !address) continue;
    try {
      if (!adapter.isEnabled()) continue;
      await adapter.send(address, reply, opts);
      return true;
    } catch (err) {
      console.error(`[channels] ${name} send failed:`, err.message);
    }
  }
  return false;
}

export async function sendToPatient(patient, msg) {
  store.addMessage({ patientId: patient.id, direction: 'out', to: 'patient', text: msg.text, textEn: msg.textEn, buttons: msg.buttons });
  // Proactive messages (check-ins, reminders) honour voice mode too, not just replies.
  const voice = msg.voice ?? Boolean(patient.voiceMode);
  return route(patient, patient.channel, { ...msg, voice }, { language: patient.language });
}

export async function sendToCaregiver(patient, msg) {
  store.addMessage({ patientId: patient.id, direction: 'out', to: 'caregiver', text: msg.text, textEn: msg.textEn, buttons: msg.buttons });
  const cg = patient.caregiver ?? {};
  return route(cg, cg.channel, msg, { language: cg.language });
}

// Nurse messages aren't about one patient in general; when they are (msg.patientId), log them there too.
export async function sendToNurses(msg) {
  if (msg.patientId) store.addMessage({ patientId: msg.patientId, direction: 'out', to: 'nurse', text: msg.text, textEn: msg.textEn, buttons: msg.buttons });
  return route({ chatId: process.env.NURSE_CHAT_ID }, 'telegram', msg, {});
}
