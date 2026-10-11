// Nurse → patient messaging (P1-6). Closes the loop: the patient hears back from a
// human, in their own language, and every message is logged + audited.
//
//   sendNurseMessage(patientId, { text | template: 'call_scheduled', time?, from? })
//   notifyAck(alert, by)   // "Nurse Kim saw your update" when an alert is acknowledged
//   notifyAckMany(alerts, by)   // the same for a bulk acknowledge: one message per patient
import * as store from '../store.js';
import * as clock from './clock.js';
import * as channels from '../channels/index.js';
import { t, hasNative, localize, translateFromEnglish, generatedTemplate } from './i18n.js';

const TEMPLATES = { call_scheduled: 'nurse_call_scheduled', ask_bp: 'nurse_ask_bp' };
// Alerts where the patient is waiting on a human; refill/SDOH tasks already told them.
const ACK_NOTIFY_KINDS = new Set(['triage', 'unreachable', 'device', 'question', 'med_discrepancy']);

// A template in the patient's language: native (en/es) or via the LLM chain (English fallback).
async function templated(p, key, vars) {
  const textEn = t('en', key, vars);
  const text = hasNative(p.language) ? t(p.language, key, vars) : await localize(p.language, textEn);
  return { text, textEn };
}

// "<nurse> (your care team): <text>" assembled in code. The wrapper is never sent through a model
// together with the body (a sentinel the model drops loses the whole message); it comes from a
// native or generated template, else a plain "<nurse>:" prefix. An untranslated body keeps the
// English wrapper so the patient sees one consistent English message (en/es have a native one).
function wrapNurseSays(lang, nurse, text, translated) {
  if (hasNative(lang)) return t(lang, 'nurse_says', { nurse, text });
  if (!translated) return t('en', 'nurse_says', { nurse, text });
  return generatedTemplate(lang, 'nurse_says', { nurse, text }) ?? `👩‍⚕️ ${nurse}: ${text}`;
}

export async function sendNurseMessage(patientId, { text, template, time, from } = {}) {
  const p = store.getPatient(patientId);
  if (!p) throw Object.assign(new Error('patient not found'), { status: 404 });
  if ((text != null && typeof text !== 'string') || (from != null && typeof from !== 'string') || (time != null && typeof time !== 'string') || (template != null && typeof template !== 'string')) {
    throw Object.assign(new Error('text, template, time and from must be strings'), { status: 400 });
  }
  const nurse = from?.trim().slice(0, 80) || 'Your nurse';
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
    msg = {
      text: wrapNurseSays(p.language, nurse, translated, didTranslate),
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

// Does acknowledging this alert tell the patient? Once per alert, and only where they are waiting on us.
const wantsAckNotice = (alert) => !!alert && !alert.patientNotifiedAt && alert.tier !== 'INFO' && ACK_NOTIFY_KINDS.has(alert.kind);

export async function notifyAck(alert, by) {
  if (!wantsAckNotice(alert)) return null;
  const p = store.getPatient(alert.patientId);
  if (!p) return null;
  const nurse = by?.trim() || 'Your nurse';
  const msg = await templated(p, 'nurse_ack', { nurse });
  const delivered = await channels.sendToPatient(p, msg);
  store.updateAlert(alert.id, { patientNotifiedAt: clock.nowISO() });
  store.audit('nurse_ack_notice', p.id, { alertId: alert.id, nurse, delivered });
  return { delivered };
}

// Several alerts acknowledged in one go (the bulk action). A patient with three of them must not
// get "<nurse> saw your update" three times in a row: each patient hears it once, and every alert
// that message covers is stamped, so none of them is ever notified again. -> messages sent.
export async function notifyAckMany(alerts, by) {
  const byPatient = new Map();
  for (const a of alerts) {
    if (!wantsAckNotice(a)) continue;
    if (!byPatient.has(a.patientId)) byPatient.set(a.patientId, []);
    byPatient.get(a.patientId).push(a);
  }
  let sent = 0;
  for (const [first, ...rest] of byPatient.values()) {
    if (!(await notifyAck(first, by))) continue;
    sent++;
    const at = store.getAlert(first.id).patientNotifiedAt;
    for (const a of rest) store.updateAlert(a.id, { patientNotifiedAt: at });
  }
  return sent;
}
