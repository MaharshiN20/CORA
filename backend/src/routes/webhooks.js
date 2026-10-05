// Inbound webhooks for non-Telegram channels (Krish lane). Mounted at /webhooks.
//
//   POST /webhooks/twilio/sms        form-encoded { From, Body, NumMedia?, MediaUrl0?, MediaContentType0? }
//   POST /webhooks/twilio/whatsapp   same, From = "whatsapp:+1..."
//
// "JOIN <CODE>" links the phone (GARCIA1 = patient, CG_GARCIA1 = caregiver, DEMO / DEMO_ES = judge mode).
// Anything else goes to handleInbound; a bare number answers the last numbered menu.
// Replies go out through the REST API and the webhook answers with empty TwiML. With no
// Twilio credentials (or if the REST call fails) the replies ride back inside the TwiML.
import { Router } from 'express';
import * as store from '../store.js';
import { handleInbound, startCheckin } from '../core/agent.js';
import { enrollDemoPatient, isSupportedLanguage } from '../core/enroll.js';
import { t, localize } from '../core/i18n.js';
import * as twilio from '../channels/twilio.js';
import { remember, resolve, normalizePhone } from '../channels/options.js';
import { transcribe } from '../integrations/speech.js';

export const webhooks = Router();

const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The URL Twilio signed. Behind ngrok/a proxy the local req.protocol is wrong, so prefer
// PUBLIC_URL, then the forwarded headers.
function publicUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '') + req.originalUrl;
  const proto = req.get('x-forwarded-proto')?.split(',')[0] ?? req.protocol;
  const host = req.get('x-forwarded-host') ?? req.get('host');
  return `${proto}://${host}${req.originalUrl}`;
}

function checkSignature(req, res, next) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return next(); // local dev / tests without Twilio: nothing to verify against
  if (twilio.validSignature(token, req.get('x-twilio-signature'), publicUrl(req), req.body ?? {})) return next();
  console.warn('[webhooks] rejected Twilio request with a bad signature (check PUBLIC_URL)');
  res.status(403).type('text/plain').send('invalid signature');
}

// One phone = one person. Returns { role, patient } like store.findByChatId.
export function findByPhone(phone) {
  const key = normalizePhone(phone);
  if (!key) return null;
  for (const p of store.listPatients()) {
    if (normalizePhone(p.phone) === key) return { role: 'patient', patient: p };
    if (normalizePhone(p.caregiver?.phone) === key) return { role: 'caregiver', patient: p };
  }
  return null;
}

function unlinkPhone(phone) {
  for (let link = findByPhone(phone); link; link = findByPhone(phone)) {
    const { patient } = link;
    if (link.role === 'caregiver') store.updatePatient(patient.id, { caregiver: { ...patient.caregiver, phone: null } });
    else store.updatePatient(patient.id, { phone: null });
  }
}

const langOf = (link) => (link.role === 'caregiver' ? link.patient.caregiver?.language ?? 'en' : link.patient.language);

// JOIN <CODE>: returns { link, replies } or null for an unknown code.
async function join(code, phone, channel) {
  const raw = code.trim().toUpperCase();
  const demo = raw.match(/^DEMO(?:_([A-Z]{2}))?$/);
  if (demo) {
    unlinkPhone(phone);
    const lang = demo[1]?.toLowerCase();
    const patient = enrollDemoPatient({ language: isSupportedLanguage(lang) ? lang : 'en' });
    store.updatePatient(patient.id, { phone, channel });
    const link = { role: 'patient', patient };
    return { link, replies: [await welcome(link), ...(await startCheckin(patient.id))] };
  }
  const isCaregiver = raw.startsWith('CG_');
  const patient = store.getPatientByCode(isCaregiver ? raw.slice(3) : raw);
  if (!patient) return null;
  unlinkPhone(phone);
  if (isCaregiver) store.updatePatient(patient.id, { caregiver: { ...patient.caregiver, phone, channel } });
  else store.updatePatient(patient.id, { phone, channel });
  store.audit('channel_link', patient.id, { channel, role: isCaregiver ? 'caregiver' : 'patient' });
  const link = { role: isCaregiver ? 'caregiver' : 'patient', patient };
  return { link, replies: [await welcome(link)] };
}

async function welcome(link) {
  const lang = langOf(link);
  const key = link.role === 'caregiver' ? 'welcome_caregiver' : 'welcome_patient';
  const vars = { name: link.patient.name.split(' ')[0] };
  return { text: await localize(lang, t(lang, key, vars)), textEn: t('en', key, vars) };
}

// Twilio media URLs need the account credentials to download.
async function downloadMedia(url) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token } = process.env;
  const headers = sid && token ? { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` } : {};
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`media HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_MEDIA_BYTES) return 'too_large';
  return buffer;
}

// Inbound message (already linked) -> Reply[]
async function inbound(link, phone, channel, body) {
  const base = { patientId: link.patient.id, role: link.role, channel };
  const lang = langOf(link);
  const mediaType = body.MediaContentType0 ?? '';
  if (Number(body.NumMedia) > 0 && body.MediaUrl0 && /^(image|audio)\//.test(mediaType)) {
    let media;
    try {
      media = await downloadMedia(body.MediaUrl0);
    } catch (err) {
      console.error('[webhooks] media download failed:', err.message);
    }
    if (media === 'too_large') return [{ text: await localize(lang, t(lang, 'file_too_large')) }];
    if (mediaType.startsWith('image/')) {
      if (!media) return [{ text: await localize(lang, t(lang, 'photo_failed')) }];
      return handleInbound({ ...base, photo: { base64: media.toString('base64'), mime: mediaType } });
    }
    if (mediaType.startsWith('audio/')) {
      const transcript = media ? await transcribe(media, mediaType, lang) : null;
      if (!transcript) return [{ text: await localize(lang, t(lang, 'voice_unavailable')) }];
      const replies = await handleInbound({ ...base, voiceTranscript: transcript });
      return [{ text: t(lang, 'heard', { text: transcript }) }, ...replies];
    }
  }
  const text = String(body.Body ?? '').trim();
  const option = resolve(phone, text);
  if (option) return handleInbound({ ...base, buttonData: option.data });
  return handleInbound({ ...base, text });
}

function twiml(messages = []) {
  const inner = messages.map((m) => `<Message>${escapeXml(m)}</Message>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

// Try the REST API first; whatever couldn't be sent that way is returned for the TwiML reply.
async function deliver(channel, phone, replies, language) {
  const adapter = channel === 'sms' ? twilio.sms : twilio.whatsapp;
  let i = 0;
  if (adapter.isEnabled()) {
    for (; i < replies.length; i++) {
      try {
        await adapter.send(phone, replies[i], { language });
      } catch (err) {
        console.error(`[webhooks] ${channel} REST reply failed, answering in TwiML:`, err.message);
        break;
      }
    }
  }
  // Rendered like the REST path (urgent styling, numbered options, length cap).
  const rest = replies.slice(i).map((r) => twilio.bodyFor(channel, r));
  const menu = rest.findLast((r) => r.options.length);
  if (menu) remember(phone, menu.options);
  return rest.map((r) => r.text);
}

function handler(channel) {
  return async (req, res) => {
    const body = req.body ?? {};
    const phone = normalizePhone(body.From);
    if (!phone) return res.status(400).type('text/plain').send('missing From');
    try {
      const text = String(body.Body ?? '').trim();
      const joinMatch = text.match(/^JOIN\s+(\S+)$/i);
      let link = null;
      let replies;
      if (joinMatch) {
        const joined = await join(joinMatch[1], phone, channel);
        if (joined) ({ link, replies } = joined);
        else replies = [{ text: t('en', 'unknown_code_sms') }];
        if (link) for (const r of replies) store.addMessage({ patientId: link.patient.id, direction: 'out', to: link.role, text: r.text, textEn: r.textEn, buttons: r.buttons, channel });
      } else {
        link = findByPhone(phone);
        replies = link ? await inbound(link, phone, channel, body) : [{ text: t('en', 'unknown_code_sms') }];
      }
      const leftover = await deliver(channel, phone, replies, link ? langOf(link) : 'en');
      res.type('text/xml').send(twiml(leftover));
    } catch (err) {
      console.error(`[webhooks] ${channel} inbound failed:`, err);
      res.type('text/xml').send(twiml()); // never make Twilio retry into the same bug
    }
  };
}

webhooks.get('/', (_req, res) =>
  res.json({ ok: true, sms: twilio.sms.isEnabled(), whatsapp: twilio.whatsapp.isEnabled(), signatureCheck: Boolean(process.env.TWILIO_AUTH_TOKEN) }),
);
webhooks.post('/twilio/sms', checkSignature, handler('sms'));
webhooks.post('/twilio/whatsapp', checkSignature, handler('whatsapp'));
