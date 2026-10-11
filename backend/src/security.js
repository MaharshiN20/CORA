// HTTP/socket hardening in one place (shared file, mounted from app.js and index.js).
//
// Rules of thumb:
//  - No key should ever be required to run or test: with API_TOKEN unset the API stays open
//    (index.js prints a warning). Set API_TOKEN for anything reachable by other people.
//  - Everything is read from process.env per request, so tests and ops can flip it live.
//  - No new dependencies: the limiter and headers are tiny and easy to audit.
import crypto from 'node:crypto';

// ---------- API token ----------
// health is polled by the UI; ready by load balancers and monitors (counts and booleans only); join links are public QR targets
const PUBLIC_PATHS = new Set(['/health', '/ready', '/join']);

// Constant-time string compare (hashing first makes the lengths equal). Also used for webhook secrets.
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export const tokenRequired = () => !!process.env.API_TOKEN;

function bearer(req) {
  const h = req.headers.authorization;
  if (typeof h === 'string' && /^Bearer /i.test(h)) return h.slice(7).trim();
  return req.headers['x-api-token'];
}

// Home devices authenticate with their own key (DEVICE_KEY), and it opens one endpoint only.
const isDeviceEndpoint = (req) => req.method === 'POST' && req.path.replace(/\/$/, '') === '/devices/readings';
export function deviceKeyOk(req) {
  const key = process.env.DEVICE_KEY;
  const given = req.headers['x-device-key'];
  return !!key && typeof given === 'string' && !!given && safeEqual(given, key);
}

// Mount on '/api'. req.path is relative to the mount point.
export function apiAuth(req, res, next) {
  if (isDeviceEndpoint(req) && process.env.DEVICE_KEY) {
    // A configured device key is required on this endpoint, and replaces the nurse token there.
    if (deviceKeyOk(req)) return next();
    if (tokenRequired()) {
      const given = bearer(req);
      if (typeof given === 'string' && given && safeEqual(given, process.env.API_TOKEN)) return next();
    }
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!tokenRequired() || req.method === 'OPTIONS' || PUBLIC_PATHS.has(req.path.replace(/\/$/, '') || '/')) return next();
  const given = bearer(req);
  if (typeof given === 'string' && given && safeEqual(given, process.env.API_TOKEN)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// socket.io middleware: the dashboard sends { auth: { token } } in the handshake.
export function socketAuth(socket, next) {
  if (!tokenRequired()) return next();
  const given = socket.handshake?.auth?.token;
  if (typeof given === 'string' && given && safeEqual(given, process.env.API_TOKEN)) return next();
  next(new Error('unauthorized'));
}

// ---------- demo gating ----------
// Reset / clock-advance / cohort-regenerate are destructive. On in dev, off in production unless
// DEMO_MODE=1 (and DEMO_MODE=0 turns them off anywhere).
export function demoEnabled() {
  const m = process.env.DEMO_MODE;
  if (m === '1') return true;
  if (m === '0') return false;
  return process.env.NODE_ENV !== 'production';
}
export function demoOnly(_req, res, next) {
  if (demoEnabled()) return next();
  res.status(404).json({ error: 'not found' });
}

// ---------- CORS ----------
// CORS_ORIGIN="https://dash.example.org,https://other" restricts browsers to those origins.
// Unset: only this machine's own pages in dev (localhost / loopback / private-LAN, so the Vite
// dashboard and a phone on the same wifi work), closed in production. It used to reflect ANY
// origin in dev, which let a page on another site read every patient (audit 2026-10-11 S6).
const PRIVATE_HOST =
  /^(?:localhost|\[?::1\]?|0\.0\.0\.0|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[a-z0-9-]+\.local)$/i;
const hostnameOf = (hostOrOrigin) => {
  try {
    return new URL(/^[a-z]+:\/\//i.test(hostOrOrigin) ? hostOrOrigin : `http://${hostOrOrigin}`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
};
export function corsOrigin() {
  const list = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length) return list;
  return process.env.NODE_ENV === 'production' ? false : true;
}
// May a page from `origin` talk to this API from a browser? (No Origin header = not a browser page.)
export function originAllowed(origin) {
  if (!origin) return true;
  const allowed = corsOrigin();
  if (allowed === false) return false;
  if (allowed === true) return PRIVATE_HOST.test(hostnameOf(origin));
  return allowed.includes(origin);
}
export const corsOptions = {
  origin: (origin, cb) => cb(null, !!origin && originAllowed(origin)),
};

// ---------- cross-site request protection (audit 2026-10-11 S6) ----------
// With no API_TOKEN the API is open by design (no key needed to run or test). Without more, any web
// page the nurse visits could POST a plain HTML form to it (no CORS preflight) and create patients,
// message patients as "Nurse", move the demo clock or wipe the database; a rebinding domain could read.
//  - writes from a browser page must come from an allowed Origin (browsers always send Origin on a
//    cross-site POST; curl, tests and servers send none and are unaffected);
//  - in dev with no token, the Host must be this machine (blocks DNS rebinding); ALLOWED_HOSTS adds more.
// Setting API_TOKEN makes both moot (a header a foreign page cannot set), so they step aside.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export function crossSiteGuard(req, res, next) {
  if (tokenRequired()) return next();
  if (!SAFE_METHODS.has(req.method)) {
    const origin = req.headers.origin;
    if (origin !== undefined && (origin === 'null' || !originAllowed(origin))) return res.status(403).json({ error: 'cross-site request blocked' });
    if (origin === undefined && req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'cross-site request blocked' });
  }
  if (process.env.NODE_ENV !== 'production' && req.headers.host) {
    const host = hostnameOf(req.headers.host);
    const extra = (process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
    if (!PRIVATE_HOST.test(host) && !extra.includes(host)) return res.status(421).json({ error: 'unexpected Host header' });
  }
  next();
}

// ---------- headers ----------
export function securityHeaders(_req, res, next) {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store'); // PHI: never cache API responses
  next();
}

// ---------- rate limiting ----------
// Fixed-window counter per (bucket, ip). In-memory: fine for one process; a reverse proxy
// should do the real thing in production. Uses the monotonic clock, not the demo clock, so
// advancing the demo time never resets limits.
const hits = new Map();
const now = () => performance.now();

export function resetRateLimits() {
  hits.clear();
}

// skip(req) -> true lets a request through uncounted (a path that has its own bucket).
export function rateLimit({ name, max, windowMs = 60_000, skip }) {
  return (req, res, next) => {
    if (skip?.(req)) return next();
    const t = now();
    if (hits.size > 5000) for (const [k, v] of hits) if (t > v.until) hits.delete(k); // no idle-key leak
    const key = `${name}:${req.ip}`;
    let h = hits.get(key);
    if (!h || t > h.until) hits.set(key, (h = { n: 0, until: t + windowMs }));
    if (++h.n > max) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((h.until - t) / 1000)));
      return res.status(429).json({ error: 'too many requests' });
    }
    next();
  };
}

// ---------- errors ----------
export function notFound(_req, res) {
  res.status(404).json({ error: 'not found' });
}

// Last middleware. Client errors (bad JSON, too large) keep a short message; anything else is
// logged server-side and answered generically, so stack traces and internals never leave.
export function errorHandler(err, req, res, _next) {
  const status = Number(err.status ?? err.statusCode) || 500;
  if (status >= 500) console.error(`[api] ${req.method} ${req.path}: ${err.message}`);
  if (res.headersSent) return res.end();
  const msg =
    status === 413 ? 'request body too large'
    : err.type === 'entity.parse.failed' ? 'invalid JSON body'
    : status < 500 ? err.message
    : 'internal error';
  res.status(status).json({ error: msg });
}

// ---------- care-code linking ----------
// A care code (GARCIA1) hands over a patient's chat, so it must not be a master key:
//  - once a slot (patient or caregiver) is linked to one chat/phone, a different one can't take it
//    over until a nurse releases it (POST /api/patients/:id/unlink). Dev and tests stay friendly:
//    re-linking is allowed unless ALLOW_RELINK=0, or NODE_ENV=production without ALLOW_RELINK=1.
//  - guessing is throttled: 5 unknown codes per chat/phone per 10 minutes.
export function relinkAllowed() {
  const v = process.env.ALLOW_RELINK;
  if (v === '1') return true;
  if (v === '0') return false;
  return process.env.NODE_ENV !== 'production';
}
// holder = who the slot is linked to now (chat id / normalized phone / null); requester = who asks.
export const canClaim = (holder, requester) => holder == null || holder === requester || relinkAllowed();

const JOIN_MAX_MISSES = 5;
const JOIN_WINDOW_MS = 10 * 60_000;
const misses = new Map();
export const resetJoinThrottle = () => misses.clear();
export function joinBlocked(key) {
  const m = misses.get(key);
  if (!m) return false;
  if (now() > m.until) {
    misses.delete(key);
    return false;
  }
  return m.n >= JOIN_MAX_MISSES;
}
export function joinMissed(key) {
  const t = now();
  if (misses.size > 5000) for (const [k, v] of misses) if (t > v.until) misses.delete(k);
  const m = misses.get(key);
  if (!m || t > m.until) misses.set(key, { n: 1, until: t + JOIN_WINDOW_MS });
  else m.n++;
}
