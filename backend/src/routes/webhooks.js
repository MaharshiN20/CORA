// Inbound webhooks (Krish lane). Mounted at /webhooks.
//
//   POST /webhooks/twilio/sms        form-encoded { From, Body, NumMedia?, MediaUrl0?, MediaContentType0? }
//   POST /webhooks/twilio/whatsapp   same, From = "whatsapp:+1..."
//   POST /webhooks/telegram          a Telegram update (JSON), only in webhook mode
//   POST /webhooks/withings          signed Withings measure groups -> device readings
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
import * as telegram from '../channels/telegram.js';
import { remember, resolve, normalizePhone } from '../channels/options.js';
import { transcribe } from '../integrations/speech.js';
import { verifyWithingsSignature, withingsReadings } from '../integrations/devices.js';
import { ingestReading } from '../core/devicetriage.js';
import * as sec from '../security.js';
import { readBodyCapped } from '../channels/resilience.js';

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

// Fails closed in production: no auth token (or no PUBLIC_URL to rebuild the signed URL from)
// means anyone could forge an inbound message as any linked patient. TWILIO_SKIP_VERIFY=1 is the
// explicit, loud opt-out for a deploy that verifies at a proxy instead.
function checkSignature(req, res, next) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const prod = process.env.NODE_ENV === 'production' && process.env.TWILIO_SKIP_VERIFY !== '1';
  if (!token) {
    if (!prod) return next(); // local dev / tests without Twilio: nothing to verify against
    console.warn('[webhooks] rejected: TWILIO_AUTH_TOKEN is not set in production (set it, or TWILIO_SKIP_VERIFY=1 to opt out)');
    return res.status(403).type('text/plain').send('webhooks not configured');
  }
  if (prod && !process.env.PUBLIC_URL) {
    console.warn('[webhooks] rejected: PUBLIC_URL must be set in production to verify Twilio signatures');
    return res.status(403).type('text/plain').send('webhooks not configured');
  }
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
  // Same rule as Telegram: a linked slot is locked to its phone until a nurse releases it.
  const holder = normalizePhone(isCaregiver ? patient.caregiver?.phone : patient.phone);
  if (!sec.canClaim(holder, normalizePhone(phone))) {
    store.audit('link_refused', patient.id, { channel, role: isCaregiver ? 'caregiver' : 'patient' });
    return { refused: true };
  }
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

// Twilio media URLs need the account credentials to download. MediaUrl0 comes from the request
// body, so it is only ever fetched (and the credentials only ever sent) when it is an https URL
// on api.twilio.com; anything else would make us a proxy to internal hosts or leak the token.
const TWILIO_MEDIA_HOST = 'api.twilio.com';
function trustedMediaUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === TWILIO_MEDIA_HOST ? u : null;
  } catch {
    return null;
  }
}

async function downloadMedia(rawUrl) {
  const url = trustedMediaUrl(rawUrl);
  if (!url) throw new Error('media URL is not on api.twilio.com');
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token } = process.env;
  const headers = sid && token ? { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` } : {};
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`media HTTP ${res.status}`);
  return (await readBodyCapped(res, MAX_MEDIA_BYTES)) ?? 'too_large';
}

// Inbound message (already linked) -> Reply[]
async function inbound(link, phone, channel, body) {
  const base = { patientId: link.patient.id, role: link.role, channel, messageId: body.MessageSid };
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
        const throttleKey = `sms:${phone}`;
        const joined = sec.joinBlocked(throttleKey) ? null : await join(joinMatch[1], phone, channel);
        if (joined?.refused) replies = [{ text: t('en', 'code_in_use') }];
        else if (joined) ({ link, replies } = joined);
        else {
          if (!/^DEMO/i.test(joinMatch[1])) sec.joinMissed(throttleKey);
          replies = [{ text: t('en', 'unknown_code_sms') }];
        }
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

// ---------- Withings ----------
// Which patient a device account belongs to. A lane-owned collection, so the patient record
// doesn't grow a field per vendor. The OAuth callback will call linkDevice() when it exists;
// until then a link is made when the patient is given the device.
const deviceLinks = () => store.collection('device_links');

export function linkDevice(provider, userId, patientId) {
  if (!store.getPatient(patientId)) return null;
  const key = String(userId);
  let link = deviceLinks().find((l) => l.provider === provider && l.userId === key);
  if (link) link.patientId = patientId;
  else deviceLinks().push((link = { provider, userId: key, patientId }));
  store.persist();
  store.audit('device_link', patientId, { provider });
  return link;
}

export function findDevicePatient(provider, userId) {
  if (userId == null) return null;
  const link = deviceLinks().find((l) => l.provider === provider && l.userId === String(userId));
  return link ? (store.getPatient(link.patientId) ?? null) : null;
}

// Fails closed in production like the Twilio check: without the secret anyone could post a
// weight for a linked patient, and raise an alert or hide a real gain behind a fake reading.
function checkWithingsSignature(req, res, next) {
  const secret = process.env.WITHINGS_CLIENT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV !== 'production') return next(); // local dev / tests: nothing to verify against
    console.warn('[webhooks] rejected: WITHINGS_CLIENT_SECRET is not set in production');
    return res.status(403).json({ error: 'webhook not configured' });
  }
  // app.js keeps this route's body as raw bytes; a parsed-and-rebuilt body would not hash the same.
  if (Buffer.isBuffer(req.body) && verifyWithingsSignature(req.body, req.headers, secret)) return next();
  console.warn('[webhooks] rejected Withings request with a bad signature');
  res.status(403).json({ error: 'invalid signature' });
}

// POST /webhooks/withings  { userid, measuregrps: [...] } (the shape of Withings' getmeas answer)
//   -> 200 { ok, accepted: [{ readingId, type, value, tier }], duplicates, rejected: [{ grpid, type?, reason }] }
// Each measure takes the same path as POST /api/devices/readings. Its readingId comes from the
// Withings group id, so a delivery that is repeated stores nothing twice. A delivery we understood
// is always answered 200, even if every value in it was refused: retrying bad data cannot fix it.
webhooks.post('/withings', checkWithingsSignature, async (req, res) => {
  let parsed;
  try {
    parsed = withingsReadings(JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''));
  } catch {
    return res.status(400).json({ error: 'body must be JSON with a measuregrps array' });
  }
  const patient = findDevicePatient('withings', parsed.userId);
  if (!patient) return res.status(404).json({ error: 'unknown Withings user' });
  const summary = { ok: true, accepted: [], duplicates: 0, rejected: parsed.rejected };
  for (const r of parsed.readings) {
    const { status, body } = await ingestReading({ patientId: patient.id, type: r.type, value: r.value, ts: r.ts, readingId: r.readingId, device: 'withings' });
    if (status === 201) summary.accepted.push({ readingId: r.readingId, type: r.type, value: r.value, tier: body.tier });
    else if (status === 200) summary.duplicates++;
    else summary.rejected.push({ grpid: r.grpid, type: r.type, reason: body.error });
  }
  // A scale that keeps sending nonsense is worth a trace on the patient's record.
  if (summary.rejected.length) store.audit('device_rejected', patient.id, { device: 'withings', rejected: summary.rejected });
  res.json(summary);
});

// Telegram webhook mode (TELEGRAM_WEBHOOK_URL). The secret check, the update_id de-duplication
// and the handling all live in channels/telegram.js; this only maps the outcome to HTTP.
webhooks.post('/telegram', async (req, res) => {
  const { status, error } = await telegram.handleWebhook(req.body, req.get('x-telegram-bot-api-secret-token'));
  res.status(status).json(error ? { error } : { ok: true });
});
