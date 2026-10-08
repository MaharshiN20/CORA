// K8: Telegram webhook mode. Real express app on a random port, an offline bot from the
// harness (every Telegram API call is recorded, none is sent).
import { test, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-channels-webhook-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, telegram, security, r, h, server, base;

before(async () => {
  store = await import('../src/store.js');
  telegram = await import('../src/channels/telegram.js');
  security = await import('../src/security.js');
  r = await import('../src/channels/resilience.js');
  h = await import('./channels.harness.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const URL_ = 'https://hb.example.org';
const SECRET = 'S3cret_token-1';
const ENV_KEYS = ['TELEGRAM_WEBHOOK_URL', 'TELEGRAM_WEBHOOK_SECRET', 'NODE_ENV'];

beforeEach(() => {
  store.reset();
  security.resetRateLimits();
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  telegram.useBot(null);
});

function webhookOn({ secret = SECRET } = {}) {
  process.env.TELEGRAM_WEBHOOK_URL = URL_;
  if (secret) process.env.TELEGRAM_WEBHOOK_SECRET = secret;
  const made = h.makeBot();
  telegram.useBot(made.bot);
  return made;
}

async function deliver(update, secret) {
  const res = await fetch(`${base}/webhooks/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret !== undefined && { 'X-Telegram-Bot-Api-Secret-Token': secret }) },
    body: JSON.stringify(update),
  });
  return { status: res.status, body: await res.json() };
}

const quiet = async (fn) => {
  const saved = [console.log, console.warn, console.error];
  const lines = [];
  console.log = console.warn = console.error = (...a) => lines.push(a.join(' '));
  try {
    await fn();
  } finally {
    [console.log, console.warn, console.error] = saved;
  }
  return lines;
};

const MARIA = 4242;
const inbound = () => store.listMessages('p1').filter((m) => m.direction === 'in').map((m) => m.text);

// ---------- config ----------
test('no TELEGRAM_WEBHOOK_URL: long polling stays the default', () => {
  assert.deepEqual(telegram.webhookConfig({}), { mode: 'polling' });
  assert.deepEqual(telegram.webhookConfig({ TELEGRAM_WEBHOOK_URL: '  ', TELEGRAM_WEBHOOK_SECRET: SECRET }), { mode: 'polling' });
});

test('a base URL gets the webhook path; a full URL is used as given', () => {
  const env = { TELEGRAM_WEBHOOK_SECRET: SECRET };
  assert.deepEqual(telegram.webhookConfig({ ...env, TELEGRAM_WEBHOOK_URL: 'https://hb.example.org' }), { mode: 'webhook', url: 'https://hb.example.org/webhooks/telegram', secret: SECRET });
  assert.equal(telegram.webhookConfig({ ...env, TELEGRAM_WEBHOOK_URL: 'https://hb.example.org/' }).url, 'https://hb.example.org/webhooks/telegram');
  assert.equal(telegram.webhookConfig({ ...env, TELEGRAM_WEBHOOK_URL: 'https://proxy.example.org/hb/webhooks/telegram' }).url, 'https://proxy.example.org/hb/webhooks/telegram');
});

test('a URL Telegram could never call, or a secret it would reject, is refused with a reason', () => {
  const refused = (env) => {
    const c = telegram.webhookConfig(env);
    assert.equal(c.mode, 'refused', JSON.stringify(env));
    return c.reason;
  };
  assert.match(refused({ TELEGRAM_WEBHOOK_URL: 'http://hb.example.org', TELEGRAM_WEBHOOK_SECRET: SECRET }), /https/);
  assert.match(refused({ TELEGRAM_WEBHOOK_URL: 'not a url', TELEGRAM_WEBHOOK_SECRET: SECRET }), /valid URL/);
  assert.match(refused({ TELEGRAM_WEBHOOK_URL: URL_, TELEGRAM_WEBHOOK_SECRET: 'has spaces!' }), /A-Z a-z 0-9/);
  assert.match(refused({ TELEGRAM_WEBHOOK_URL: URL_, TELEGRAM_WEBHOOK_SECRET: 'x'.repeat(257) }), /256/);
});

test('production fails closed when the URL is set but the secret is not; dev allows it', () => {
  assert.deepEqual(telegram.webhookConfig({ TELEGRAM_WEBHOOK_URL: URL_, NODE_ENV: 'production' }), { mode: 'refused', reason: 'TELEGRAM_WEBHOOK_SECRET is required in production' });
  assert.deepEqual(telegram.webhookConfig({ TELEGRAM_WEBHOOK_URL: URL_, NODE_ENV: 'development' }), { mode: 'webhook', url: `${URL_}/webhooks/telegram`, secret: null });
  assert.equal(telegram.webhookConfig({ TELEGRAM_WEBHOOK_URL: URL_, TELEGRAM_WEBHOOK_SECRET: SECRET, NODE_ENV: 'production' }).mode, 'webhook');
});

// ---------- the route ----------
test('a delivery with the right secret is handled like a polled update', async () => {
  const { calls } = webhookOn();
  const res = await deliver(h.textUpdate(MARIA, '/start GARCIA1'), SECRET);
  assert.deepEqual(res, { status: 200, body: { ok: true } });
  assert.equal(store.findByChatId(MARIA)?.patient.id, 'p1');
  assert.ok(h.lastSent(calls).text, 'the welcome went out through the bot');

  await deliver(h.textUpdate(MARIA, 'hola'), SECRET);
  assert.deepEqual(inbound(), ['hola']);
});

test('a wrong or missing secret is rejected with 403 and never reaches the bot', async () => {
  const { calls } = webhookOn();
  for (const given of ['wrong', '', `${SECRET}x`, SECRET.toLowerCase(), undefined]) {
    const res = await deliver(h.textUpdate(MARIA, '/start GARCIA1'), given);
    assert.deepEqual(res, { status: 403, body: { error: 'invalid secret' } }, `secret ${JSON.stringify(given)}`);
  }
  assert.equal(calls.length, 0);
  assert.equal(store.findByChatId(MARIA), null);
});

test('a replayed update_id is acknowledged but handled only once', async () => {
  webhookOn();
  await deliver(h.textUpdate(MARIA, '/start GARCIA1'), SECRET);
  const update = h.textUpdate(MARIA, 'me siento bien');
  assert.equal((await deliver(update, SECRET)).status, 200);
  const sentBefore = store.listMessages('p1').length;
  for (let i = 0; i < 3; i++) assert.deepEqual(await deliver(update, SECRET), { status: 200, body: { ok: true } }, 'Telegram must get a 2xx or it keeps re-sending');
  assert.deepEqual(inbound(), ['me siento bien']);
  assert.equal(store.listMessages('p1').length, sentBefore, 'no second reply either');
});

test('two deliveries of one update racing each other still run it once', async () => {
  webhookOn();
  await deliver(h.textUpdate(MARIA, '/start GARCIA1'), SECRET);
  const update = h.textUpdate(MARIA, 'hola');
  await Promise.all([deliver(update, SECRET), deliver(update, SECRET), deliver(update, SECRET)]);
  assert.deepEqual(inbound(), ['hola']);
});

test('polling mode (the default): the webhook route is closed, even with a bot running', async () => {
  const { bot, calls } = h.makeBot();
  telegram.useBot(bot);
  const res = await deliver(h.textUpdate(MARIA, '/start GARCIA1'), SECRET);
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
  assert.equal(store.findByChatId(MARIA), null);
});

test('webhook URL set but no bot (no token): 404, nothing crashes', async () => {
  process.env.TELEGRAM_WEBHOOK_URL = URL_;
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  assert.equal((await deliver(h.textUpdate(MARIA, 'hi'), SECRET)).status, 404);
});

test('production with a URL but no secret: every delivery is refused', async () => {
  const { calls } = webhookOn({ secret: null });
  process.env.NODE_ENV = 'production';
  for (const given of [undefined, '', 'anything']) {
    assert.deepEqual(await deliver(h.textUpdate(MARIA, '/start GARCIA1'), given), { status: 403, body: { error: 'telegram webhook is not configured' } });
  }
  assert.equal(calls.length, 0);
});

test('dev without a secret: deliveries are accepted (nothing to verify against)', async () => {
  webhookOn({ secret: null });
  assert.equal((await deliver(h.textUpdate(MARIA, '/start GARCIA1'))).status, 200);
  assert.equal(store.findByChatId(MARIA)?.patient.id, 'p1');
});

test('a body that is not a Telegram update is a 400, after the secret check', async () => {
  webhookOn();
  for (const body of [{}, { update_id: 'abc' }, { message: { text: 'hi' } }, [1, 2]]) assert.equal((await deliver(body, SECRET)).status, 400, JSON.stringify(body));
  assert.equal((await deliver({}, 'wrong')).status, 403, 'an unauthenticated caller learns nothing about the body');
});

test('a handler error is logged and still acknowledged, so Telegram does not re-send into the same bug', async () => {
  const { bot } = webhookOn();
  bot.api.config.use(async () => {
    throw new Error('telegram is down');
  });
  const update = h.textUpdate(MARIA, '/start GARCIA1');
  let res;
  const lines = await quiet(async () => {
    res = await deliver(update, SECRET);
  });
  assert.equal(res.status, 200);
  assert.ok(lines.some((l) => l.includes('telegram is down')), 'the failure is logged');
  assert.equal(store.findByChatId(MARIA)?.patient.id, 'p1', 'the link itself happened before the send failed');
});

test('Telegram has its own rate-limit bucket: its traffic never uses up the Twilio one', async () => {
  let last;
  for (let i = 0; i < 130; i++) last = await deliver({ update_id: 1 }, 'x');
  assert.equal(last.status, 404, 'past the 120/min webhook limit and still answered, not throttled');
  const sms = await fetch(`${base}/webhooks/twilio/sms`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ From: '+14045550100', Body: 'hi' }) });
  assert.equal(sms.status, 200);
});

// ---------- start / stop ----------
const methods = (calls) => calls.map((c) => c.method);

test('launch in webhook mode registers the URL with the secret and never polls', async () => {
  const { bot, calls } = h.makeBot();
  telegram.useBot(bot);
  let polled = false;
  bot.start = async () => (polled = true);
  let mode;
  await quiet(async () => {
    mode = await telegram.launch(bot, telegram.webhookConfig({ TELEGRAM_WEBHOOK_URL: URL_, TELEGRAM_WEBHOOK_SECRET: SECRET }));
  });
  assert.equal(mode, 'webhook');
  assert.equal(telegram.receiveMode(), 'webhook');
  assert.equal(polled, false);
  const set = calls.find((c) => c.method === 'setWebhook').payload;
  assert.equal(set.url, `${URL_}/webhooks/telegram`);
  assert.equal(set.secret_token, SECRET);
  assert.deepEqual(set.allowed_updates, ['message', 'callback_query', 'my_chat_member']);
  assert.equal(set.drop_pending_updates, undefined, 'messages sent while we were down are kept');
});

test('launch without a webhook URL polls exactly as before and never calls setWebhook', async () => {
  const { bot, calls } = h.makeBot();
  telegram.useBot(bot);
  let polled = 0;
  bot.start = async () => void polled++;
  const mode = await telegram.launch(bot, telegram.webhookConfig({}));
  assert.equal(mode, 'polling');
  assert.equal(polled, 1);
  assert.deepEqual(methods(calls), []);
});

test('launch with a refused config neither polls nor registers, and says why', async () => {
  const { bot, calls } = h.makeBot();
  telegram.useBot(bot);
  let polled = false;
  bot.start = async () => (polled = true);
  let mode;
  const lines = await quiet(async () => {
    mode = await telegram.launch(bot, telegram.webhookConfig({ TELEGRAM_WEBHOOK_URL: URL_, NODE_ENV: 'production' }));
  });
  assert.equal(mode, 'refused');
  assert.equal(polled, false);
  assert.deepEqual(methods(calls), []);
  assert.ok(lines.some((l) => /TELEGRAM_WEBHOOK_SECRET is required in production/.test(l)));
});

test('a failed setWebhook is reported, not thrown; a dead poller is reported too', async () => {
  const { bot } = h.makeBot({ results: {} });
  bot.api.config.use(async (prev, method, payload) => (method === 'setWebhook' ? { ok: false, error_code: 400, description: 'Bad Request: bad webhook' } : prev(method, payload)));
  telegram.useBot(bot);
  let mode;
  const lines = await quiet(async () => {
    mode = await telegram.launch(bot, { mode: 'webhook', url: `${URL_}/webhooks/telegram`, secret: SECRET });
  });
  assert.equal(mode, 'failed');
  assert.ok(lines.some((l) => /setWebhook failed/.test(l)));

  const poller = h.makeBot().bot;
  poller.start = async () => {
    throw Object.assign(new Error('Conflict'), { error_code: 409 });
  };
  const pollLines = await quiet(async () => {
    await telegram.launch(poller, { mode: 'polling' });
    await new Promise((res) => setImmediate(res));
  });
  assert.equal(telegram.receiveMode(), 'failed');
  assert.ok(pollLines.some((l) => /409 Conflict/.test(l)));
});

test('stop() leaves the webhook registered; stop({ deleteWebhook: true }) removes it', async () => {
  const hook = { mode: 'webhook', url: `${URL_}/webhooks/telegram`, secret: SECRET };
  const first = h.makeBot();
  telegram.useBot(first.bot);
  await quiet(() => telegram.launch(first.bot, hook));
  await telegram.stop();
  assert.ok(!methods(first.calls).includes('deleteWebhook'), 'Telegram keeps queueing for the restart');
  assert.equal(telegram.receiveMode(), 'off');

  const second = h.makeBot();
  telegram.useBot(second.bot);
  await quiet(() => telegram.launch(second.bot, hook));
  await telegram.stop({ deleteWebhook: true });
  assert.ok(methods(second.calls).includes('deleteWebhook'));

  const poller = h.makeBot();
  telegram.useBot(poller.bot);
  poller.bot.start = async () => {};
  await telegram.launch(poller.bot, { mode: 'polling' });
  await telegram.stop({ deleteWebhook: true });
  assert.ok(!methods(poller.calls).includes('deleteWebhook'), 'nothing to delete when polling');
});

test('stop() with no bot is a no-op', async () => {
  telegram.useBot(null);
  await telegram.stop({ deleteWebhook: true });
});

// ---------- de-duplication helper ----------
test('dedupe remembers an id for the TTL, then lets it through again', () => {
  let t = 0;
  const d = r.createDedupe({ ttlMs: 1000, now: () => t });
  assert.equal(d.seen(7), false);
  assert.equal(d.seen(7), true);
  assert.equal(d.seen(8), false);
  t = 999;
  assert.equal(d.seen(7), true);
  t = 1000;
  assert.equal(d.seen(7), false, 'expired');
  assert.equal(d.seen(7), true);
});

test('dedupe forgets expired ids, so it cannot grow without bound', () => {
  let t = 0;
  const d = r.createDedupe({ ttlMs: 1000, now: () => t });
  for (let i = 0; i < 6000; i++) d.seen(i);
  t = 5000;
  d.seen('trigger');
  assert.ok(d.size() < 10, `size ${d.size()}`);
  d.reset();
  assert.equal(d.size(), 0);
});
