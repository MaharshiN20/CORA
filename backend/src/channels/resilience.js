// Channel hardening (K7): per-chat rate limiting, retrying Telegram API calls, and
// readable polling errors. Pure helpers with injectable time/sleep so tests run instantly.
import * as clock from '../core/clock.js';

// Sliding window: at most `limit` hits per `windowMs` per key (chat id).
// hit(key) -> true if allowed. Keeps only timestamps inside the window, so memory stays small.
export function createRateLimiter({ limit = 20, windowMs = 60_000, now = clock.now } = {}) {
  const hits = new Map();
  return {
    hit(key) {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((ts) => t - ts < windowMs && ts <= t);
      const allowed = recent.length < limit;
      if (allowed) recent.push(t);
      hits.set(key, recent);
      return allowed;
    },
    reset: () => hits.clear(),
  };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// grammY API transformer. One retry for:
//   429 Too Many Requests -> wait retry_after (if it's short enough to be worth waiting)
//   5xx / network errors  -> wait a second
// getUpdates is left alone: grammY's poller already has its own retry loop.
export function retryTransformer({ sleep = defaultSleep, maxRetryAfterS = 30, transientDelayMs = 1000, log = console.warn } = {}) {
  return async (prev, method, payload, signal) => {
    if (method === 'getUpdates') return prev(method, payload, signal);
    let res;
    try {
      res = await prev(method, payload, signal);
    } catch (err) {
      log(`[telegram] ${method} failed (${err.message}), retrying once`);
      await sleep(transientDelayMs);
      return prev(method, payload, signal);
    }
    if (res.ok) return res;
    if (res.error_code === 429) {
      const wait = res.parameters?.retry_after ?? 1;
      if (wait > maxRetryAfterS) return res;
      log(`[telegram] ${method} rate limited, retrying in ${wait}s`);
      await sleep(wait * 1000);
      return prev(method, payload, signal);
    }
    if (res.error_code >= 500) {
      log(`[telegram] ${method} got ${res.error_code}, retrying once`);
      await sleep(transientDelayMs);
      return prev(method, payload, signal);
    }
    return res;
  };
}

// What to tell a teammate when polling dies.
export function describePollingError(err) {
  const code = err?.error_code;
  if (code === 409) {
    return (
      '[telegram] 409 Conflict: another process is already polling this bot token ' +
      '(a second `npm run dev`, or a teammate using your token). Stop it or use your own bot from @BotFather. ' +
      'Incoming Telegram messages will not reach this process; sending and the dashboard still work.'
    );
  }
  if (code === 401) return '[telegram] 401 Unauthorized: TELEGRAM_BOT_TOKEN is wrong or revoked. Get a fresh one from @BotFather.';
  return `[telegram] polling stopped: ${err?.message ?? err}`;
}
