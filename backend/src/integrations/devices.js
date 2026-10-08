// Home devices (Krish lane): the shared client behind tools/virtual-scale.js and
// tools/virtual-oximeter.js, and the place a real device integration would plug in.
//
// Readings go to the backend's POST /api/devices/readings (docs/CONTRACTS.md §4), exactly
// what a cellular scale or a Withings webhook would do, so the demo exercises the real path.
// Trends advance the demo clock between readings (POST /api/demo/advance) so "5 days of
// weight gain" happens in seconds and the scheduler sees each day go by.
import crypto from 'node:crypto';

// Same limits the API enforces (routes/api.js), checked here so a typo fails fast and clearly.
export const RANGES = { weight: [50, 700], spo2: [50, 100], hr: [20, 250] };

export const DEFAULT_API = 'http://localhost:3001';

export function validateReading({ patientId, type, value }) {
  if (!patientId) throw new Error('--patient is required (e.g. --patient p1)');
  const range = RANGES[type];
  if (!range) throw new Error(`type must be one of ${Object.keys(RANGES).join(', ')}`);
  if (!Number.isFinite(value) || value < range[0] || value > range[1]) {
    throw new Error(`${type} ${value} is outside ${range[0]}-${range[1]}`);
  }
}

// Tiny argv parser: "--patient p1 --lb 177.4 --dry-run" -> { patient: 'p1', lb: '177.4', 'dry-run': true }
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}"`);
    const [key, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) out[key] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

// "+0.8/day", "-1/d", "0.5" -> change per day
export function parseTrend(s) {
  const m = String(s).trim().match(/^([+-]?\d+(?:\.\d+)?)(?:\s*\/\s*(?:day|d))?$/i);
  if (!m) throw new Error(`--trend must look like +0.8/day (got "${s}")`);
  return Number(m[1]);
}

export function parseNumber(s, name) {
  const n = Number(s);
  if (s === undefined || s === true || !Number.isFinite(n)) throw new Error(`--${name} needs a number`);
  return n;
}

const round1 = (n) => Math.round(n * 10) / 10;

// A day-by-day series: day 0 = first, then + perDay each day.
export function planSeries({ first, perDay = 0, days = 1 }) {
  if (!Number.isInteger(days) || days < 1 || days > 60) throw new Error('--days must be a whole number from 1 to 60');
  return Array.from({ length: days }, (_, i) => round1(first + perDay * i));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POST JSON with retries on network errors and 5xx (a backend restarting mid-demo);
// 4xx means the request itself is wrong, so it fails immediately with the server's message.
export async function postJSON(url, body, { retries = 2, retryDelayMs = 500, fetchImpl = fetch } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(retryDelayMs * attempt);
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.DEVICE_KEY && { 'x-device-key': process.env.DEVICE_KEY }) }, body: JSON.stringify(body) });
    } catch (err) {
      lastErr = new Error(`cannot reach ${url} (${err.cause?.code ?? err.message}). Is the backend running?`);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    lastErr = new Error(`${url} -> HTTP ${res.status}${data.error ? `: ${data.error}` : ''}`);
    if (res.status < 500) throw lastErr;
  }
  throw lastErr;
}

export async function getJSON(url, { fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    throw new Error(`cannot reach ${url} (${err.cause?.code ?? err.message}). Is the backend running?`);
  }
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

export function postReading(api, { patientId, type, value, device }, opts) {
  validateReading({ patientId, type, value });
  return postJSON(`${api}/api/devices/readings`, { patientId, type, value, device }, opts);
}

export const advanceClock = (api, hours, opts) => postJSON(`${api}/api/demo/advance`, { hours }, opts);

// Post one reading per day, moving the demo clock a day between them.
// readingsFor(value) -> [{ type, value }] so the oximeter can send SpO2 + heart rate together.
export async function runSeries(api, { patientId, device, values, readingsFor, log = () => {} }, opts) {
  const posted = [];
  for (let day = 0; day < values.length; day++) {
    if (day > 0) {
      const { now } = await advanceClock(api, 24, opts);
      log(`⏩ demo clock -> ${now}`);
    }
    for (const r of readingsFor(values[day])) {
      posted.push(await postReading(api, { patientId, device, ...r }, opts));
      log(`📡 ${patientId} ${r.type} ${r.value} (day ${day + 1}/${values.length})`);
    }
  }
  return posted;
}

// Run a CLI main() with friendly errors instead of stack traces.
export async function runCli(main, argv, log = console.log) {
  try {
    await main(argv, { log });
    return 0;
  } catch (err) {
    console.error(`✖ ${err.message}`);
    return 1;
  }
}

// ---------- Withings ----------
// What runs: POST /webhooks/withings (routes/webhooks.js) takes measure groups in the shape of
// Withings' own `getmeas` answer, checks the signature below, and feeds each measure through the
// same path as POST /api/devices/readings (core/devicetriage.js ingestReading).
//
// What does not run yet (the `withings` stub at the bottom): the OAuth half. Withings itself only
// notifies "user X has new data" (unsigned, no values). A full integration 1) sends the patient to
// Withings OAuth (https://account.withings.com/oauth2_user/authorize2, scope user.metrics),
// 2) exchanges the code for tokens (POST https://wbsapi.withings.net/v2/oauth2
// action=requesttoken), 3) subscribes to notifications (POST /notify action=subscribe, appli=1),
// 4) on each one fetches the measures (POST /measure action=getmeas) and posts them, signed with
// the client secret, to the webhook above. Tokens would live in store.collection('device_tokens').

export const WITHINGS_SIGNATURE_HEADER = 'x-withings-signature';

// Hex HMAC-SHA256 of the exact request bytes, keyed with the Withings client secret.
export function withingsSignature(rawBody, secret) {
  return crypto.createHmac('sha256', String(secret)).update(rawBody).digest('hex');
}

// rawBody: the request body as received (Buffer or string), before any JSON parsing: a
// re-serialised body would not hash the same. The header may carry a "sha256=" prefix.
// Compared in constant time. -> boolean (false for a missing secret, header or body).
export function verifyWithingsSignature(rawBody, headers, secret) {
  if (!secret || rawBody == null) return false;
  const given = headers?.[WITHINGS_SIGNATURE_HEADER];
  if (typeof given !== 'string') return false;
  const hex = given.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return false; // not a SHA-256 digest: nothing to compare
  return crypto.timingSafeEqual(Buffer.from(hex, 'hex'), Buffer.from(withingsSignature(rawBody, secret), 'hex'));
}

const KG_TO_LB = 2.2046226218;
// Withings measure type -> our reading type (https://developer.withings.com/api-reference#tag/measure).
const WITHINGS_TYPES = {
  1: { type: 'weight', convert: (kg) => kg * KG_TO_LB }, // kg
  11: { type: 'hr', convert: (bpm) => bpm },
  54: { type: 'spo2', convert: (pct) => pct },
};

// A Withings payload { userid, measuregrps: [{ grpid, attrib, date, category, measures: [{ value, type, unit }] }] }
// -> { userId, readings: [{ type, value, ts, readingId, grpid }], rejected: [{ grpid, type?, reason }] }.
// Pure. A real value is value * 10^unit. Types we don't monitor (fat mass, ...) are skipped
// silently; anything that can't be trusted is listed in `rejected` so it leaves a trace:
//   - a group the scale could not attribute (attrib 1: someone else may have stepped on it)
//   - a goal rather than a measurement (category 2)
//   - no group id (a retry could not be recognised) or no usable date / number
export function withingsReadings(payload) {
  const readings = [];
  const rejected = [];
  const groups = Array.isArray(payload?.measuregrps) ? payload.measuregrps : null;
  if (!groups) throw new Error('measuregrps must be an array');
  for (const g of groups) {
    const grpid = typeof g?.grpid === 'number' || typeof g?.grpid === 'string' ? String(g.grpid) : null;
    const reject = (reason, type) => rejected.push({ grpid, ...(type && { type }), reason });
    if (!grpid || !/^[\w-]{1,40}$/.test(grpid)) {
      reject('no measure group id');
      continue;
    }
    if (g.category === 2) {
      reject('a goal, not a measurement');
      continue;
    }
    if (g.attrib === 1) {
      reject('the device could not tell who was measured');
      continue;
    }
    if (!Number.isFinite(g.date) || g.date <= 0) {
      reject('no measurement date');
      continue;
    }
    const ts = new Date(g.date * 1000).toISOString();
    for (const m of Array.isArray(g.measures) ? g.measures : []) {
      const known = WITHINGS_TYPES[m?.type];
      if (!known) continue;
      if (!Number.isFinite(m.value) || !Number.isInteger(m.unit ?? 0) || Math.abs(m.unit ?? 0) > 9) {
        reject('not a number', known.type);
        continue;
      }
      const value = Math.round(known.convert(m.value * 10 ** (m.unit ?? 0)) * 10) / 10;
      readings.push({ type: known.type, value, ts, readingId: `withings:${grpid}:${m.type}`, grpid });
    }
  }
  const userId = typeof payload.userid === 'number' || typeof payload.userid === 'string' ? String(payload.userid) : null;
  return { userId, readings, rejected };
}

export const withings = {
  enabled: () => false,
  authorizeUrl() {
    throw new Error('Withings integration is not implemented (see integrations/devices.js)');
  },
};
