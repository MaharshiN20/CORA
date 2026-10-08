// HTTP/socket hardening in one place (shared file, mounted from app.js and index.js).
//
// Rules of thumb:
//  - No key should ever be required to run or test: with API_TOKEN unset the API stays open
//    (index.js prints a warning). Set API_TOKEN for anything reachable by other people.
//  - Everything is read from process.env per request, so tests and ops can flip it live.
//  - No new dependencies: the limiter and headers are tiny and easy to audit.
import crypto from 'node:crypto';

// ---------- API token ----------
const PUBLIC_PATHS = new Set(['/health', '/join']); // health is polled by the UI; join links are public QR targets

function safeEqual(a, b) {
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

// Mount on '/api'. req.path is relative to the mount point.
export function apiAuth(req, res, next) {
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
// Unset: open in dev (the Vite proxy is same-origin anyway), closed in production.
export function corsOrigin() {
  const list = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length) return list;
  return process.env.NODE_ENV === 'production' ? false : true;
}
export const corsOptions = {
  origin: (origin, cb) => {
    const allowed = corsOrigin();
    if (allowed === true) return cb(null, true);
    if (allowed === false || !origin) return cb(null, false);
    cb(null, allowed.includes(origin));
  },
};

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

export function rateLimit({ name, max, windowMs = 60_000 }) {
  return (req, res, next) => {
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
