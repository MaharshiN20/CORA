// Is this instance fit to serve, and is it set up the way its operator thinks? (shared file)
//
//   readiness()          -> { ready, checks } for GET /api/ready
//   configWarnings(env)  -> [{ code, message }], logged once at startup by index.js
//
// GET /api/ready is public (load balancers and uptime monitors can't log in), so it carries
// booleans, counts and mode names only: never a token, chat id, phone number, URL or file path.
// `ready` is false only when the store can't be written. Everything else has a fallback
// (no Telegram -> dashboard, no LLM -> rules), but with no store every answer is lost. The other
// checks carry their own `ok` so a monitor can alert on them.
import * as store from './store.js';
import * as channels from './channels/index.js';
import * as telegram from './channels/telegram.js';
import * as twilio from './channels/twilio.js';
import * as llm from './core/llm/index.js';
import * as jobs from './core/jobs.js';
import { fhirTarget } from './integrations/fhir.js';

// Test hook: swap the disk probe (null puts the real one back).
let probeStore = () => store.checkWritable();
export function _setStoreProbe(fn) {
  probeStore = fn ?? (() => store.checkWritable());
}

const countBy = (rows, statuses) => {
  const counts = Object.fromEntries(statuses.map((s) => [s, 0]));
  for (const r of rows) if (Object.hasOwn(counts, r.status)) counts[r.status]++;
  return counts;
};

// The tick loop is what sends check-ins, reminders and outbox retries. It is healthy when it is
// on and not stuck: three missed ticks in a row means something is blocking it.
export const schedulerOk = ({ running, intervalMs, msSinceTick }) => running && !(msSinceTick !== null && msSinceTick > 3 * intervalMs);

function schedulerCheck() {
  const status = jobs.status();
  return {
    ok: schedulerOk(status),
    running: status.running,
    secondsSinceTick: status.msSinceTick === null ? null : Math.round(status.msSinceTick / 1000),
    ...countBy(store.collection('jobs'), ['pending', 'failed']),
  };
}

// Telegram is optional ('off' is fine). Not fine: a webhook that was refused, or receiving that died.
function telegramCheck() {
  const mode = telegram.receiveMode();
  return { ok: mode !== 'refused' && mode !== 'failed', enabled: telegram.isEnabled(), mode };
}

// Which channels can reach the care team right now (the same test channels/index.js applies when
// it sends). None = alerts only show on the dashboard.
function nurseCheck(env) {
  const address = { telegram: env.NURSE_CHAT_ID, sms: env.NURSE_PHONE, whatsapp: env.NURSE_PHONE };
  const via = channels.listAdapters().filter((a) => address[a.name] && a.isEnabled()).map((a) => a.name);
  return { ok: via.length > 0, via };
}

export function readiness(env = process.env) {
  const checks = {
    store: probeStore(),
    scheduler: schedulerCheck(),
    telegram: telegramCheck(),
    twilio: { sms: twilio.sms.isEnabled(), whatsapp: twilio.whatsapp.isEnabled(), signatureCheck: Boolean(env.TWILIO_AUTH_TOKEN) },
    llm: llm.status(),
    nurseChannel: nurseCheck(env),
    outbox: countBy(store.collection('outbox'), ['pending', 'dead']),
  };
  return { ready: checks.store.ok, checks };
}

// ---------- startup config check ----------
// One entry per thing that is probably not what the operator meant. Pure: reads only `env`.
export function configWarnings(env = process.env) {
  const set = (k) => Boolean(String(env[k] ?? '').trim());
  const prod = env.NODE_ENV === 'production';
  const out = [];
  const warn = (code, message) => out.push({ code, message });

  if (!set('API_TOKEN')) {
    warn('api_token_unset', 'API_TOKEN is not set: the API and live feed are open to anyone who can reach this port. Set it before exposing the server.');
  }
  if (prod && !set('CORS_ORIGIN')) {
    warn('cors_origin_unset', 'NODE_ENV=production without CORS_ORIGIN: browsers on any other origin are blocked. Set it to the dashboard\'s origin unless the dashboard is served from this same address.');
  }
  if (set('TWILIO_AUTH_TOKEN') && !set('PUBLIC_URL')) {
    warn(
      'twilio_public_url_unset',
      `TWILIO_AUTH_TOKEN is set without PUBLIC_URL: ${prod ? 'every SMS/WhatsApp webhook will be refused (403)' : 'webhook signatures are checked against a guessed URL and will fail behind ngrok or a proxy'}. Set PUBLIC_URL to the public base URL Twilio calls.`,
    );
  }
  const twilioReady = set('TWILIO_ACCOUNT_SID') && set('TWILIO_AUTH_TOKEN') && (set('TWILIO_SMS_FROM') || set('TWILIO_WHATSAPP_FROM'));
  if (!set('NURSE_CHAT_ID') && !set('NURSE_PHONE')) {
    warn('nurse_channel_unset', 'No nurse channel (NURSE_CHAT_ID / NURSE_PHONE): alerts only appear on the dashboard, nobody is paged.');
  } else {
    // Set, but pointing at a channel that isn't configured: the page would silently go nowhere.
    const telegramWorks = set('NURSE_CHAT_ID') && set('TELEGRAM_BOT_TOKEN');
    const phoneWorks = set('NURSE_PHONE') && twilioReady;
    if (!telegramWorks && !phoneWorks) {
      const why = [set('NURSE_CHAT_ID') && 'NURSE_CHAT_ID needs TELEGRAM_BOT_TOKEN', set('NURSE_PHONE') && 'NURSE_PHONE needs the TWILIO_* settings'].filter(Boolean).join('; ');
      warn('nurse_channel_unusable', `The nurse channel can't deliver (${why}): alerts only appear on the dashboard, nobody is paged.`);
    }
  }
  const ehr = fhirTarget(env);
  if (prod && ehr.sandbox) {
    warn(
      'fhir_public_sandbox',
      ehr.allowed
        ? 'FHIR_BASE_URL points at the public HAPI sandbox and DEMO_MODE=1 allows it: EHR searches go to a public server. Made-up patients only.'
        : 'FHIR_BASE_URL points at the public HAPI sandbox in production: EHR search and import are refused (503) until it is set to your own FHIR server.',
    );
  }
  return out;
}
