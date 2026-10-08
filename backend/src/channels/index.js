// Outbound routing. Core code calls these and doesn't care which channel is live.
// If no channel is configured or the person hasn't linked one yet, the message
// still lands in the dashboard log so the demo never silently drops it.
//
// Adapters: { name, isEnabled(), send(address, reply, opts) }. A person is reached on
// their preferred channel (patient.channel, default telegram); if that's disabled,
// unlinked or the send fails, any other enabled channel they have an address for.
//
// Delivery you can trust: every logged message carries `delivery`:
//   sent      reached a channel
//   queued    every channel failed; it is in the outbox and will be retried with backoff
//   failed    the outbox gave up (see the delivery_dead audit row)
//   unlinked  nothing to send to (no linked/enabled channel), so there is nothing to retry
// An alert whose nurse message is queued is flagged `undelivered` until a retry gets through.
import * as store from '../store.js';
import * as clock from '../core/clock.js';
import * as telegram from './telegram.js';
import * as twilio from './twilio.js';
import { scrub } from './resilience.js';

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

// -> { ok, reason }: reason is 'no_channel' when nothing was even tried (no address / disabled),
// 'failed' when at least one channel was tried and every one failed.
async function route(person, preferred, reply, opts) {
  const addresses = addressesOf(person);
  const order = [...new Set([preferred || 'telegram', ...Object.keys(adapters)])];
  let tried = false;
  for (const name of order) {
    const adapter = adapters[name];
    const address = addresses[name];
    if (!adapter || !address) continue;
    try {
      if (!adapter.isEnabled()) continue;
      tried = true;
      await adapter.send(address, reply, opts);
      return { ok: true, channel: name };
    } catch (err) {
      console.error(`[channels] ${name} send failed:`, scrub(err.message));
    }
  }
  return { ok: false, reason: tried ? 'failed' : 'no_channel' };
}

// ---------- outbox ----------
// A failed send is not lost: it waits here and flushOutbox() (every scheduler tick, and after a
// demo-clock jump) retries it. Retrying a send can in rare cases deliver twice (the first attempt
// reached the person but its answer was lost); for an unanswered "call 911" or a RED page that is
// the right trade, and routine messages get fewer, slower attempts.
const MAX_ATTEMPTS = { routine: 5, urgent: 12 };
const outbox = () => store.collection('outbox');
const backoffMs = (attempts, urgent) => (urgent ? Math.min(60_000 * attempts, 5 * 60_000) : Math.min(2 * 60_000 * 2 ** (attempts - 1), 30 * 60_000));

function enqueue({ to, patientId = null, reply, urgent, alertId, messageId }) {
  const entry = {
    id: crypto.randomUUID(),
    ts: clock.nowISO(),
    to,
    patientId,
    reply,
    urgent,
    alertId: alertId ?? null,
    messageId: messageId ?? null,
    attempts: 1,
    nextAt: new Date(clock.now() + backoffMs(1, urgent)).toISOString(),
    status: 'pending',
  };
  outbox().push(entry);
  store.persist('update', null);
  return entry;
}

function recipient(entry) {
  if (entry.to === 'nurse') return { person: nurseTarget(), preferred: 'telegram', opts: {} };
  const patient = store.getPatient(entry.patientId);
  if (!patient) return null;
  if (entry.to === 'caregiver') return { person: patient.caregiver ?? {}, preferred: patient.caregiver?.channel, opts: { language: patient.caregiver?.language } };
  return { person: patient, preferred: patient.channel, opts: { language: patient.language } };
}

let flushing = null;
// Retry everything that is due. -> { sent, failed, dead }. Never throws; concurrent calls share one run.
export function flushOutbox() {
  flushing ??= doFlush().finally(() => (flushing = null));
  return flushing;
}

async function doFlush() {
  const summary = { sent: 0, failed: 0, dead: 0 };
  try {
    const due = outbox().filter((e) => e.status === 'pending' && Date.parse(e.nextAt) <= clock.now());
    for (const e of due) {
      const target = recipient(e);
      const result = target ? await route(target.person, target.preferred, e.reply, target.opts) : { ok: false, reason: 'no_channel' };
      if (result.ok) {
        e.status = 'sent';
        e.sentAt = clock.nowISO();
        e.channel = result.channel;
        summary.sent++;
        if (e.messageId) store.updateMessage(e.messageId, { delivery: 'sent' });
        if (e.alertId && store.getAlert(e.alertId)?.undelivered) {
          store.updateAlert(e.alertId, { undelivered: false });
          store.audit('delivery_recovered', e.patientId, { to: e.to, alertId: e.alertId, attempts: e.attempts + 1 });
        }
        continue;
      }
      e.attempts++;
      summary.failed++;
      const max = MAX_ATTEMPTS[e.urgent ? 'urgent' : 'routine'];
      if (e.attempts >= max || (result.reason === 'no_channel' && e.attempts >= 3)) {
        e.status = 'dead';
        summary.dead++;
        if (e.messageId) store.updateMessage(e.messageId, { delivery: 'failed' });
        store.audit('delivery_dead', e.patientId, { to: e.to, attempts: e.attempts, alertId: e.alertId, urgent: e.urgent });
        console.error(`[channels] giving up on a ${e.urgent ? 'URGENT ' : ''}message to ${e.to} after ${e.attempts} attempts`);
      } else {
        e.nextAt = new Date(clock.now() + backoffMs(e.attempts, e.urgent)).toISOString();
      }
    }
  } catch (err) {
    console.error('[channels] outbox flush failed:', scrub(err.message));
  }
  if (summary.sent || summary.failed) store.persist('update', null);
  return summary;
}

// What happens to a message after route() has run.
function settle({ result, to, patientId, reply, urgent, alertId, messageId }) {
  if (result.ok) {
    if (messageId) store.updateMessage(messageId, { delivery: 'sent' });
    return true;
  }
  if (result.reason === 'no_channel') {
    // Nothing to retry against. For a patient/caregiver that just means "not linked yet". For the
    // nurses it means nobody was told, which is worth a trail.
    if (messageId) store.updateMessage(messageId, { delivery: 'unlinked' });
    if (to === 'nurse') store.audit('delivery_failed', patientId, { to, reason: 'no nurse channel configured (NURSE_CHAT_ID / NURSE_PHONE)', alertId });
    return false;
  }
  if (messageId) store.updateMessage(messageId, { delivery: 'queued' });
  enqueue({ to, patientId, reply, urgent, alertId, messageId });
  if (alertId) store.updateAlert(alertId, { undelivered: true });
  if (to === 'nurse' || urgent) store.audit('delivery_failed', patientId, { to, reason: 'every channel failed; queued for retry', alertId });
  return false;
}

export async function sendToPatient(patient, msg) {
  const logged = store.addMessage({ patientId: patient.id, direction: 'out', to: 'patient', text: msg.text, textEn: msg.textEn, buttons: msg.buttons, delivery: 'pending' });
  // Proactive messages (check-ins, reminders) honour voice mode too, not just replies.
  const voice = msg.voice ?? Boolean(patient.voiceMode);
  const reply = { ...msg, voice };
  const result = await route(patient, patient.channel, reply, { language: patient.language });
  return settle({ result, to: 'patient', patientId: patient.id, reply, urgent: !!msg.urgent, messageId: logged.id });
}

export async function sendToCaregiver(patient, msg) {
  const logged = store.addMessage({ patientId: patient.id, direction: 'out', to: 'caregiver', text: msg.text, textEn: msg.textEn, buttons: msg.buttons, delivery: 'pending' });
  const cg = patient.caregiver ?? {};
  const result = await route(cg, cg.channel, msg, { language: cg.language });
  return settle({ result, to: 'caregiver', patientId: patient.id, reply: msg, urgent: !!msg.urgent, messageId: logged.id });
}

// Where the care team is reached: the nurse group on Telegram, and optionally a phone (SMS /
// WhatsApp) as a fallback when Telegram is down or no group is set up.
const nurseTarget = () => ({ chatId: process.env.NURSE_CHAT_ID, phone: process.env.NURSE_PHONE });

// Nurse messages aren't about one patient in general; when they are (msg.patientId), log them there too.
// msg.alertId ties the message to a worklist alert, which is flagged `undelivered` if it can't get out.
export async function sendToNurses(msg) {
  const logged = msg.patientId
    ? store.addMessage({ patientId: msg.patientId, direction: 'out', to: 'nurse', text: msg.text, textEn: msg.textEn, buttons: msg.buttons, delivery: 'pending' })
    : null;
  const { alertId, ...reply } = msg;
  const result = await route(nurseTarget(), 'telegram', reply, {});
  return settle({ result, to: 'nurse', patientId: msg.patientId ?? null, reply, urgent: true, alertId, messageId: logged?.id });
}
