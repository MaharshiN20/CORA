// Phase 4: Telegram retry policy (no blind retries of sends), token scrubbing, rate limiter
// hygiene, nurse-group lock-down, Twilio retry.
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-chsafety-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let r, store, h, twilio;
const realFetch = globalThis.fetch;
before(async () => {
  r = await import('../src/channels/resilience.js');
  store = await import('../src/store.js');
  h = await import('./channels.harness.js');
  twilio = await import('../src/channels/twilio.js');
});
beforeEach(() => store.reset());
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.NURSE_CHAT_ID;
  delete process.env.TWILIO_RETRY_MS;
});

const OK = { ok: true, result: true };
function scripted(...steps) {
  const calls = [];
  return {
    calls,
    prev: async () => {
      calls.push(1);
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      if (step instanceof Error) throw step;
      return step;
    },
  };
}
const netErr = (code) => Object.assign(new Error(`connect ${code}`), { code });
const tf = () => {
  const slept = [];
  return { slept, t: r.retryTransformer({ sleep: async (ms) => slept.push(ms), log: () => {} }) };
};

// ---- retry policy ----
test('a send that failed AFTER the request may have gone out (5xx, reset, timeout) is not blindly re-sent', async () => {
  for (const step of [{ ok: false, error_code: 502 }, netErr('ECONNRESET'), netErr('ETIMEDOUT')]) {
    const { t } = tf();
    const s = scripted(step, OK);
    if (step instanceof Error) await assert.rejects(() => t(s.prev, 'sendMessage', {}));
    else assert.equal((await t(s.prev, 'sendMessage', {})).error_code, 502);
    assert.equal(s.calls.length, 1, 'one attempt: the outbox owns retries of sends');
  }
});
test('a send that provably never left (connection refused, DNS failure) is retried once', async () => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
    const { t } = tf();
    const s = scripted(netErr(code), OK);
    assert.deepEqual(await t(s.prev, 'sendMessage', {}), OK, code);
    assert.equal(s.calls.length, 2);
  }
});
test('429 (Telegram did not process it) is retried for sends too', async () => {
  const { t, slept } = tf();
  const s = scripted({ ok: false, error_code: 429, parameters: { retry_after: 2 } }, OK);
  assert.deepEqual(await t(s.prev, 'sendMessage', {}), OK);
  assert.deepEqual(slept, [2000]);
});
test('idempotent calls (answerCallbackQuery, getFile, editMessageReplyMarkup) keep the retry-once-on-anything policy', async () => {
  for (const method of ['answerCallbackQuery', 'getFile', 'editMessageReplyMarkup', 'sendChatAction', 'setMyCommands']) {
    const { t } = tf();
    const s = scripted(netErr('ECONNRESET'), OK);
    assert.deepEqual(await t(s.prev, method, {}), OK, method);
    const s5 = scripted({ ok: false, error_code: 502 }, OK);
    assert.deepEqual(await tf().t(s5.prev, method, {}), OK, `${method} 5xx`);
  }
});
test('waits get jitter when asked for (so a fleet of retries does not synchronise)', async () => {
  const slept = [];
  const t = r.retryTransformer({ sleep: async (ms) => slept.push(ms), log: () => {}, jitterMs: 250, random: () => 0.5 });
  await t(scripted(netErr('ECONNREFUSED'), OK).prev, 'sendMessage', {});
  assert.deepEqual(slept, [1000 + 125]);
});

// ---- token scrubbing ----
test('scrub removes bot tokens from anything that gets logged', () => {
  process.env.TELEGRAM_BOT_TOKEN = '123456:ABC-def_GHI';
  const dirty = 'request to https://api.telegram.org/bot123456:ABC-def_GHI/sendMessage failed; token 123456:ABC-def_GHI';
  const clean = r.scrub(dirty);
  assert.ok(!clean.includes('ABC-def_GHI'), clean);
  assert.match(clean, /bot<redacted>/);
  assert.equal(r.scrub(new Error('x 123456:ABC-def_GHI y')), 'x <redacted> y');
  assert.equal(r.scrub(undefined), '');
  delete process.env.TELEGRAM_BOT_TOKEN;
});

// ---- rate limiter ----
test('rate limiter: uses its own clock, so moving the demo clock does not reset limits, and idle keys are forgotten', () => {
  let t = 1000;
  const lim = r.createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.ok(lim.hit('a'));
  assert.ok(lim.hit('a'));
  assert.equal(lim.hit('a'), false);
  t += 5000;
  assert.ok(lim.hit('b'));
  assert.ok(lim.hit('a'), 'window passed');
  for (let i = 0; i < 6000; i++) lim.hit(`chat${i}`);
  t += 5000;
  lim.hit('trigger');
  assert.ok(lim.size() < 100, `idle keys evicted (size ${lim.size()})`);
  const real = r.createRateLimiter({ limit: 1 });
  assert.ok(real.hit('x'));
  assert.equal(real.hit('x'), false, 'default clock is real time');
});

// ---- nurse group lock-down ----
test('with NURSE_CHAT_ID unset, no group can run /demo or /status (a random group the bot is added to learns nothing)', async () => {
  const { bot, calls } = h.makeBot();
  delete process.env.NURSE_CHAT_ID;
  await bot.handleUpdate(h.textUpdate(-9001, '/status', { chatType: 'supergroup' }));
  await bot.handleUpdate(h.textUpdate(-9001, '/demo', { chatType: 'supergroup' }));
  assert.equal(calls.filter((c) => c.method === 'sendMessage').length, 0);
  process.env.NURSE_CHAT_ID = '-9001';
  await bot.handleUpdate(h.textUpdate(-9001, '/status', { chatType: 'supergroup' }));
  assert.ok(calls.some((c) => c.method === 'sendMessage'), 'the configured nurse group still works');
  await bot.handleUpdate(h.textUpdate(-9002, '/status', { chatType: 'supergroup' }));
  assert.equal(calls.filter((c) => c.method === 'sendMessage').length, 1, 'another group does not');
});

// ---- Twilio ----
test('Twilio: a 5xx or 429 is retried once; a 4xx or a timeout is not', async () => {
  process.env.TWILIO_ACCOUNT_SID = 'AC1';
  process.env.TWILIO_AUTH_TOKEN = 't';
  process.env.TWILIO_RETRY_MS = '0';
  const run = async (...statuses) => {
    let n = 0;
    globalThis.fetch = async () => {
      const s = statuses[Math.min(n++, statuses.length - 1)];
      if (s instanceof Error) throw s;
      return Response.json(s === 201 ? { sid: 'SM1' } : { message: 'x' }, { status: s });
    };
    try {
      await twilio.sendMessage({ To: '+1', From: '+2', Body: 'x' });
      return { ok: true, calls: n };
    } catch (err) {
      return { ok: false, calls: n, message: err.message };
    }
  };
  assert.deepEqual(await run(503, 201), { ok: true, calls: 2 });
  assert.deepEqual(await run(429, 201), { ok: true, calls: 2 });
  assert.equal((await run(503, 503)).calls, 2, 'only once');
  assert.equal((await run(400)).calls, 1);
  assert.equal((await run(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))).calls, 1, 'a timeout may have been delivered');
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
});
