// Channel hardening (K7): per-chat rate limiting, retrying Telegram API calls, webhook
// de-duplication and readable polling errors. Pure helpers with injectable time/sleep so tests
// run instantly.

// Sliding window: at most `limit` hits per `windowMs` per key (chat id).
// hit(key) -> true if allowed. Keeps only timestamps inside the window, so memory stays small.
// Real time by default (not the demo clock: advancing the demo must not reset anyone's limit), and
// keys that have gone quiet are forgotten so a long-running bot doesn't collect every chat id forever.
export function createRateLimiter({ limit = 20, windowMs = 60_000, now = () => performance.now() } = {}) {
  const hits = new Map();
  return {
    hit(key) {
      const t = now();
      if (hits.size > 1000) for (const [k, v] of hits) if (!v.some((ts) => t - ts < windowMs)) hits.delete(k);
      const recent = (hits.get(key) ?? []).filter((ts) => t - ts < windowMs && ts <= t);
      const allowed = recent.length < limit;
      if (allowed) recent.push(t);
      hits.set(key, recent);
      return allowed;
    },
    reset: () => hits.clear(),
    size: () => hits.size,
  };
}

// Remembers ids for `ttlMs`, so a webhook delivery that comes twice (Telegram re-sends an update
// when our answer was slow or lost) is handled once. seen(id) -> true if the id is already known,
// otherwise it is recorded. Real time like the limiter above; expired ids are swept as it grows.
export function createDedupe({ ttlMs = 10 * 60_000, now = () => performance.now() } = {}) {
  const until = new Map();
  return {
    seen(id) {
      const t = now();
      if (until.size > 5000) for (const [k, v] of until) if (t >= v) until.delete(k);
      const expires = until.get(id);
      if (expires !== undefined && t < expires) return true;
      until.set(id, t + ttlMs);
      return false;
    },
    reset: () => until.clear(),
    size: () => until.size,
  };
}

// Anything that gets logged goes through this first: bot tokens (in URLs and bare) are masked, and
// only a message string is ever logged, never a whole error object with request details attached.
export function scrub(value) {
  let s = value instanceof Error ? value.message : String(value ?? '');
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token) s = s.split(token).join('<redacted>');
  return s.replace(/bot\d+:[\w-]+/g, 'bot<redacted>').replace(/\b\d{6,}:[\w-]{20,}\b/g, '<redacted>');
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// grammY API transformer. One retry for:
//   429 Too Many Requests -> wait retry_after (if it's short enough to be worth waiting)
//   5xx / network errors  -> wait a second
// getUpdates is left alone: grammY's poller already has its own retry loop.
// Retrying is only safe when doing the call twice is harmless. Reads and edits are. A send is not:
// if the first attempt reached Telegram and only the answer was lost (a 5xx, a reset, a timeout),
// retrying would message the patient twice. So sends are retried only when the request provably
// never went out (connection refused, DNS failure) or Telegram said it did not process it (429).
// Everything else is left to the outbox (channels/index.js), which owns retries of sends.
const SAFE_TO_REPEAT = /^(?:answerCallbackQuery|answerInlineQuery|getFile|getMe|getChat|getChatMember|sendChatAction|setMyCommands|setWebhook|deleteWebhook|editMessage\w+|deleteMessage|pinChatMessage|unpinChatMessage)$/;
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH']);
const codeOf = (err) => err?.code ?? err?.cause?.code ?? err?.error?.code ?? err?.error?.cause?.code;

export function retryTransformer({ sleep = defaultSleep, maxRetryAfterS = 30, transientDelayMs = 1000, log = console.warn, jitterMs = 0, random = Math.random } = {}) {
  const pause = (ms) => sleep(ms + Math.round(random() * jitterMs));
  return async (prev, method, payload, signal) => {
    if (method === 'getUpdates') return prev(method, payload, signal);
    const repeatable = SAFE_TO_REPEAT.test(method);
    let res;
    try {
      res = await prev(method, payload, signal);
    } catch (err) {
      if (!repeatable && !NEVER_SENT.has(codeOf(err))) throw err;
      log(`[telegram] ${method} failed (${scrub(err)}), retrying once`);
      await pause(transientDelayMs);
      return prev(method, payload, signal);
    }
    if (res.ok) return res;
    if (res.error_code === 429) {
      const wait = res.parameters?.retry_after ?? 1;
      if (wait > maxRetryAfterS) return res;
      log(`[telegram] ${method} rate limited, retrying in ${wait}s`);
      await pause(wait * 1000);
      return prev(method, payload, signal);
    }
    if (res.error_code >= 500 && repeatable) {
      log(`[telegram] ${method} got ${res.error_code}, retrying once`);
      await pause(transientDelayMs);
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

// Read a fetch Response body but stop as soon as it passes maxBytes, so a hostile or broken
// server can't make us buffer gigabytes before a size check. -> Buffer, or null when too big.
export async function readBodyCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > maxBytes ? null : buf;
  }
  const chunks = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
