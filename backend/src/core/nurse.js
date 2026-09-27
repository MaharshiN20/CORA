// Nurse → patient messaging (P1-6). Closes the loop: the patient hears back from a
// human, in their own language, and every message is logged + audited.
//
//   sendNurseMessage(patientId, { text | template: 'call_scheduled', time?, from? })
//   notifyAck(alert, by)   // "Nurse Kim saw your update" when an alert is acknowledged
import * as store from '../store.js';
import * as clock from './clock.js';
import * as channels from '../channels/index.js';
import { t, hasNative, localize, translateFromEnglish } from './i18n.js';

const TEMPLATES = { call_scheduled: 'nurse_call_scheduled' };
// Alerts where the patient is waiting on a human; refill/SDOH tasks already told them.
const ACK_NOTIFY_KINDS = new Set(['triage', 'unreachable', 'device', 'question', 'med_discrepancy']);

// A template in the patient's language: native (en/es) or via the LLM chain (English fallback).
async function templated(p, key, vars) {
  const textEn = t('en', key, vars);
  const text = hasNative(p.language) ? t(p.language, key, vars) : await localize(p.language, textEn);
  return { text, textEn };
}

export async function sendNurseMessage(patientId, { text, template, time, from } = {}) {
  const p = store.getPatient(patientId);
  if (!p) throw Object.assign(new Error('patient not found'), { status: 404 });
  const nurse = from?.trim() || 'Your nurse';
  let msg;

  if (template) {
    const key = TEMPLATES[template];
    if (!key) throw Object.assign(new Error(`unknown template "${template}"`), { status: 400 });
    if (template === 'call_scheduled' && !time) throw Object.assign(new Error('time is required'), { status: 400 });
    msg = await templated(p, key, { nurse, time });
  } else {
    if (!text?.trim()) throw Object.assign(new Error('text or template is required'), { status: 400 });
    const body = text.trim().slice(0, 1000);
    const { text: translated, translated: didTranslate } = await translateFromEnglish(p.language, body);
    const wrapper = await templated(p, 'nurse_says', { nurse, text: '\u0000' });
    msg = {
      text: wrapper.text.replace('\u0000', translated),
      textEn: t('en', 'nurse_says', { nurse, text: body }),
      translated: didTranslate,
    };
  }

  const delivered = await channels.sendToPatient(p, { text: msg.text, textEn: msg.textEn });
  store.audit('nurse_message', p.id, { from: nurse, template: template ?? null, delivered, translated: msg.translated ?? null });
  // translated: false = a non-English patient got the English text (no translator available);
  // delivered: false = logged in the chat but the patient isn't linked to a messaging app.
  const translated = p.language === 'en' ? null : template ? hasNative(p.language) || msg.text !== msg.textEn : !!msg.translated;
  return { delivered, translated, language: p.language, text: msg.text, textEn: msg.textEn };
}

export async function notifyAck(alert, by) {
  if (!alert || alert.patientNotifiedAt || alert.tier === 'INFO' || !ACK_NOTIFY_KINDS.has(alert.kind)) return null;
  const p = store.getPatient(alert.patientId);
  if (!p) return null;
  const nurse = by?.trim() || 'Your nurse';
  const msg = await templated(p, 'nurse_ack', { nurse });
  const delivered = await channels.sendToPatient(p, msg);
  store.updateAlert(alert.id, { patientNotifiedAt: clock.nowISO() });
  store.audit('nurse_ack_notice', p.id, { alertId: alert.id, nurse, delivered });
  return { delivered };
}
