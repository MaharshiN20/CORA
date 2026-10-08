// SMS + WhatsApp through the Twilio REST API (Krish lane). Plain fetch, no SDK.
// Adapter interface (docs/CONTRACTS.md §1): { name, isEnabled(), send(address, reply, opts) }.
//
// Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_FROM (+1...),
//      TWILIO_WHATSAPP_FROM (sandbox: whatsapp:+14155238886). See docs/TELEGRAM_SETUP.md.
import crypto from 'node:crypto';
import { renderNumbered, remember, normalizePhone } from './options.js';
import { tts } from '../integrations/speech.js';

const API = 'https://api.twilio.com/2010-04-01';
const MAX_BODY = 1600; // Twilio's limit for one (concatenated) message

const creds = () => ({ sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN });
const hasCreds = () => Boolean(creds().sid && creds().token);

const whatsappAddr = (n) => `whatsapp:${normalizePhone(n)}`;

// SMS has no formatting; WhatsApp renders *bold*. Both get the 🚨 so it stands out on a lock screen.
// Exported for the webhook's TwiML replies, so both ways of answering render the same.
export function bodyFor(channel, reply) {
  const { body, options } = renderNumbered(reply);
  let text = body;
  if (reply.urgent) {
    const flagged = text.startsWith('🚨') ? text : `🚨 ${text}`;
    text = channel === 'whatsapp' ? `*${flagged.replace(/\*/g, '')}*` : flagged;
  }
  return { text: text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text, options };
}

// One retry for 429 / 5xx (Twilio answered "not now", with jitter so a burst doesn't re-collide) or a
// connection that never opened. A timeout is NOT retried: the message may already be on its way, and
// a second SMS to a patient is worse than a late one. The outbox (channels/index.js) handles the rest.
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH']);

export async function sendMessage(params) {
  const { sid, token } = creds();
  const attempt = () =>
    fetch(`${API}/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(15_000),
    });
  const wait = () => {
    const base = Number(process.env.TWILIO_RETRY_MS ?? 800);
    return new Promise((r) => setTimeout(r, base + Math.round(Math.random() * base * 0.5)));
  };
  let res;
  try {
    res = await attempt();
  } catch (err) {
    if (!NEVER_SENT.has(err?.cause?.code ?? err?.code)) throw err;
    await wait();
    res = await attempt();
  }
  if ((res.status === 429 || res.status >= 500) && !res.retried) {
    await wait();
    res = await attempt();
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(`twilio HTTP ${res.status}${detail.message ? `: ${detail.message}` : ''}`);
  }
  return res.json();
}

function adapter(channel) {
  const fromEnv = channel === 'sms' ? 'TWILIO_SMS_FROM' : 'TWILIO_WHATSAPP_FROM';
  return {
    name: channel,
    isEnabled: () => hasCreds() && Boolean(process.env[fromEnv]),
    async send(address, reply, { language } = {}) {
      const { text, options } = bodyFor(channel, reply);
      const from = process.env[fromEnv];
      const params =
        channel === 'whatsapp'
          ? { To: whatsappAddr(address), From: from.startsWith('whatsapp:') ? from : whatsappAddr(from), Body: text }
          : { To: normalizePhone(address), From: from, Body: text };
      // WhatsApp plays audio attachments inline; Twilio fetches the TTS url itself.
      if (channel === 'whatsapp' && reply.voice) {
        const audio = await tts(reply.text, language);
        if (audio?.url) params.MediaUrl = audio.url;
      }
      const sent = await sendMessage(params);
      remember(address, options);
      return sent;
    },
  };
}

export const sms = adapter('sms');
export const whatsapp = adapter('whatsapp');

// ---------- inbound webhook signature (https://www.twilio.com/docs/usage/security) ----------
// HMAC-SHA1 over the exact public URL + every POST param (sorted, key then value), base64.
export function signature(authToken, url, params = {}) {
  const data = url + Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('');
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function validSignature(authToken, header, url, params) {
  if (!header) return false;
  const expected = Buffer.from(signature(authToken, url, params));
  const got = Buffer.from(String(header));
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}
