// K7: rate limiting, Telegram retries, polling errors, /status. Fully offline, no real sleeps.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-channels-resilience-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;
const NURSES = -100777;
process.env.NURSE_CHAT_ID = String(NURSES);

let store, r, h;

before(async () => {
  store = await import('../src/store.js');
  r = await import('../src/channels/resilience.js');
  h = await import('./channels.harness.js');
});
beforeEach(() => store.reset());

const quiet = async (fn) => {
  const saved = [console.log, console.warn];
  console.log = console.warn = () => {};
  try {
    return await fn();
  } finally {
    [console.log, console.warn] = saved;
  }
};

// ---------- rate limiter ----------
test('the limiter allows `limit` hits per window, then blocks', () => {
  let t = 0;
  const lim = r.createRateLimiter({ limit: 20, windowMs: 60_000, now: () => t });
  for (let i = 0; i < 20; i++) assert.equal(lim.hit(1), true, `hit ${i + 1}`);
  assert.equal(lim.hit(1), false);
  t = 59_999;
  assert.equal(lim.hit(1), false, 'still inside the window');
});

test('the window slides: old hits expire one by one', () => {
  let t = 0;
  const lim = r.createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
  lim.hit(1); // t=0
  t = 500;
  lim.hit(1); // t=500
  assert.equal(lim.hit(1), false);
  t = 1000; // the t=0 hit expired
  assert.equal(lim.hit(1), true);
  assert.equal(lim.hit(1), false);
});

test('chats are limited independently, and blocked hits do not extend the block', () => {
  let t = 0;
  const lim = r.createRateLimiter({ limit: 1, windowMs: 1000, now: () => t });
  assert.equal(lim.hit('a'), true);
  assert.equal(lim.hit('b'), true);
  for (let i = 0; i < 5; i++) assert.equal(lim.hit('a'), false);
  t = 1000;
  assert.equal(lim.hit('a'), true);
});

test('the bot drops messages over the per-chat limit before they reach the core', async () => {
  const { bot } = h.makeBot({ botOptions: { rateLimit: { limit: 3, windowMs: 60_000 } } });
  await quiet(async () => {
    for (let i = 0; i < 6; i++) await bot.handleUpdate(h.textUpdate(4242, i === 0 ? '/start GARCIA1' : `msg ${i}`));
  });
  const inbound = store.listMessages('p1').filter((m) => m.direction === 'in');
  assert.deepEqual(inbound.map((m) => m.text), ['msg 1', 'msg 2'], '/start + 2 messages, the rest dropped');
});

test('a throttled button tap is still answered so the spinner stops', async () => {
  const { bot, calls } = h.makeBot({ botOptions: { rateLimit: { limit: 1, windowMs: 60_000 } } });
  await quiet(async () => {
    await bot.handleUpdate(h.textUpdate(4242, '/start GARCIA1'));
    await bot.handleUpdate(h.tapUpdate(4242, 'cmd:checkin', { text: 'x' }));
  });
  assert.equal(calls.at(-1).method, 'answerCallbackQuery');
  assert.equal(store.getPatient('p1').checkin?.state ?? 'idle', 'idle');
});

test('the throttle warning is logged once per burst, not per message', async () => {
  const { bot } = h.makeBot({ botOptions: { rateLimit: { limit: 1, windowMs: 60_000 } } });
  const warnings = [];
  const warn = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    for (let i = 0; i < 5; i++) await bot.handleUpdate(h.textUpdate(4242, `x${i}`));
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.filter((w) => w.includes('4242')).length, 1);
});

test('rateLimit: false disables limiting', async () => {
  const { bot } = h.makeBot({ botOptions: { rateLimit: false } });
  await bot.handleUpdate(h.textUpdate(4242, '/start GARCIA1'));
  for (let i = 0; i < 25; i++) await bot.handleUpdate(h.textUpdate(4242, `m${i}`));
  assert.equal(store.listMessages('p1').filter((m) => m.direction === 'in').length, 25);
});

// ---------- retry transformer ----------
function scripted(...responses) {
  const calls = [];
  const prev = async (method, payload) => {
    calls.push(method);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { prev, calls };
}
const OK = { ok: true, result: { message_id: 1 } };

function transformer() {
  const slept = [];
  const t = r.retryTransformer({ sleep: async (ms) => slept.push(ms), log: () => {} });
  return { t, slept };
}

test('success passes straight through with a single call', async () => {
  const { t, slept } = transformer();
  const s = scripted(OK);
  assert.deepEqual(await t(s.prev, 'sendMessage', {}), OK);
  assert.equal(s.calls.length, 1);
  assert.equal(slept.length, 0);
});

test('429 waits retry_after seconds, then retries once', async () => {
  const { t, slept } = transformer();
  const s = scripted({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } }, OK);
  assert.deepEqual(await t(s.prev, 'sendMessage', {}), OK);
  assert.deepEqual(slept, [3000]);
  assert.equal(s.calls.length, 2);
});

test('a 429 with a very long retry_after is returned instead of blocking the bot', async () => {
  const { t, slept } = transformer();
  const res = { ok: false, error_code: 429, parameters: { retry_after: 600 } };
  const s = scripted(res);
  assert.deepEqual(await t(s.prev, 'sendMessage', {}), res);
  assert.equal(slept.length, 0);
});

test('5xx and network errors are retried exactly once', async () => {
  const { t } = transformer();
  const s5 = scripted({ ok: false, error_code: 502, description: 'Bad Gateway' }, OK);
  assert.deepEqual(await t(s5.prev, 'sendMessage', {}), OK);

  const net = scripted(new Error('ECONNRESET'), OK);
  assert.deepEqual(await t(net.prev, 'sendMessage', {}), OK);

  const twice = scripted(new Error('ECONNRESET'), new Error('ECONNRESET again'));
  await assert.rejects(() => t(twice.prev, 'sendMessage', {}), /again/);
  assert.equal(twice.calls.length, 2);

  const still = scripted({ ok: false, error_code: 500 }, { ok: false, error_code: 500 });
  assert.equal((await t(still.prev, 'sendMessage', {})).error_code, 500);
  assert.equal(still.calls.length, 2);
});

test('4xx client errors are not retried', async () => {
  const { t, slept } = transformer();
  const s = scripted({ ok: false, error_code: 400, description: 'Bad Request: chat not found' });
  assert.equal((await t(s.prev, 'sendMessage', {})).error_code, 400);
  assert.equal(s.calls.length, 1);
  assert.equal(slept.length, 0);
});

test('getUpdates is left to grammY\'s own poller', async () => {
  const { t } = transformer();
  const s = scripted(new Error('conflict'));
  await assert.rejects(() => t(s.prev, 'getUpdates', {}));
  assert.equal(s.calls.length, 1);
});

// ---------- polling errors ----------
test('a 409 Conflict explains the second-poller problem clearly', () => {
  const msg = r.describePollingError({ error_code: 409, message: 'Conflict: terminated by other getUpdates request' });
  assert.match(msg, /409 Conflict/);
  assert.match(msg, /another process is already polling/);
  assert.match(msg, /own bot/);
  assert.match(r.describePollingError({ error_code: 401 }), /TELEGRAM_BOT_TOKEN is wrong/);
  assert.match(r.describePollingError(new Error('socket hang up')), /polling stopped: socket hang up/);
});

// ---------- /status ----------
const groupCmd = (chatId, text) => h.textUpdate(chatId, text, { chatType: 'supergroup' });

test('/status in the nurse group reports uptime, LLM, linked patients and channels', async () => {
  const { bot, calls } = h.makeBot();
  await quiet(async () => {
    await bot.handleUpdate(h.textUpdate(4242, '/start GARCIA1'));
    await bot.handleUpdate(groupCmd(NURSES, '/status'));
  });
  const text = h.lastSent(calls).text;
  assert.match(text, /Uptime: \d+h \d+m/);
  assert.match(text, /LLM: none/);
  assert.match(text, new RegExp(`Linked patients: 1 of ${store.listPatients().length}`));
  assert.match(text, /Telegram ✅ · SMS — · WhatsApp —/);
  assert.match(text, /Demo clock: \d{4}-/);
});

test('/status from another group is ignored', async () => {
  const { bot, calls } = h.makeBot();
  await quiet(() => bot.handleUpdate(groupCmd(-100123, '/status')));
  assert.equal(calls.length, 0);
});
