// K9: GET /api/ready and the startup config check. Fully offline.
import { test, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-readiness-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, readiness, channels, telegram, jobs, h, server, base;

before(async () => {
  store = await import('../src/store.js');
  readiness = await import('../src/readiness.js');
  channels = await import('../src/channels/index.js');
  telegram = await import('../src/channels/telegram.js');
  jobs = await import('../src/core/jobs.js');
  h = await import('./channels.harness.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const ENV_KEYS = ['API_TOKEN', 'NURSE_CHAT_ID', 'NURSE_PHONE', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_SMS_FROM', 'TWILIO_WHATSAPP_FROM', 'NODE_ENV'];
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  store.reset();
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  readiness._setStoreProbe(null);
  channels.resetAdapters();
  telegram.useBot(null);
  jobs.stop();
});

const ready = async (headers) => {
  const res = await fetch(`${base}/api/ready`, { headers });
  return { status: res.status, body: await res.json() };
};

// ---------- GET /api/ready ----------
test('a bare local run is ready: 200 with every check present', async () => {
  const { status, body } = await ready();
  assert.equal(status, 200);
  assert.equal(body.ready, true);
  assert.deepEqual(Object.keys(body.checks), ['store', 'scheduler', 'telegram', 'twilio', 'llm', 'nurseChannel', 'outbox']);
  assert.deepEqual(body.checks.store, { ok: true });
  assert.deepEqual(body.checks.telegram, { ok: true, enabled: false, mode: 'off' });
  assert.deepEqual(body.checks.twilio, { sms: false, whatsapp: false, signatureCheck: false });
  assert.equal(body.checks.llm.provider, 'none');
  assert.deepEqual(body.checks.nurseChannel, { ok: false, via: [] });
  assert.deepEqual(body.checks.outbox, { pending: 0, dead: 0 });
});

test('an unwritable store is 503 with ready: false, and the rest is still reported', async () => {
  readiness._setStoreProbe(() => ({ ok: false, error: 'EACCES' }));
  const { status, body } = await ready();
  assert.equal(status, 503);
  assert.equal(body.ready, false);
  assert.deepEqual(body.checks.store, { ok: false, error: 'EACCES' });
  assert.ok(body.checks.scheduler && body.checks.outbox);
  readiness._setStoreProbe(null);
  assert.equal((await ready()).status, 200, 'recovers as soon as the disk does');
});

test('the real disk probe: a writable folder passes, a path that cannot hold a file fails without leaking it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-probe-'));
  try {
    assert.deepEqual(store.checkWritable(path.join(dir, 'sub', 'db.json')), { ok: true }, 'missing folders are created, like a real save');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'sub')), [], 'the probe file is removed');
    const blocker = path.join(dir, 'not-a-folder');
    fs.writeFileSync(blocker, 'x');
    const bad = store.checkWritable(path.join(blocker, 'db.json'));
    assert.equal(bad.ok, false);
    assert.match(bad.error, /^E[A-Z]+$/, 'an error code');
    assert.ok(!JSON.stringify(bad).includes(dir), 'no file path in the answer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(store.checkWritable(), { ok: true }, 'the live store');
});

test('it is public like /health, and carries no secrets', async () => {
  Object.assign(process.env, {
    API_TOKEN: 'api-token-value',
    NURSE_CHAT_ID: '-1009876543210',
    NURSE_PHONE: '+14045550199',
    TWILIO_ACCOUNT_SID: 'ACsid-value',
    TWILIO_AUTH_TOKEN: 'twilio-token-value',
    TWILIO_SMS_FROM: '+15550001111',
  });
  const { status, body } = await ready();
  assert.equal(status, 200, 'no token needed');
  const text = JSON.stringify(body);
  for (const secret of ['api-token-value', '1009876543210', '4045550199', 'ACsid-value', 'twilio-token-value', '5550001111', os.tmpdir(), 'heartbridge-readiness']) {
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  }
  assert.equal((await fetch(`${base}/api/patients`)).status, 401, 'the rest of the API still needs the token');
});

test('outbox rows are counted by status', async () => {
  store.collection('outbox').push({ status: 'pending' }, { status: 'pending' }, { status: 'dead' }, { status: 'sent' }, { status: 'sent' });
  assert.deepEqual((await ready()).body.checks.outbox, { pending: 2, dead: 1 });
});

test('a message that cannot be delivered shows up as pending, then dead', async () => {
  process.env.NURSE_CHAT_ID = '-100777';
  channels.setAdapter('telegram', {
    name: 'telegram',
    isEnabled: () => true,
    send: async () => {
      throw new Error('down');
    },
  });
  const error = console.error;
  console.error = () => {};
  try {
    await channels.sendToNurses({ text: 'RED alert' });
    assert.deepEqual((await ready()).body.checks.outbox, { pending: 1, dead: 0 });
    store.collection('outbox')[0].status = 'dead';
    assert.deepEqual((await ready()).body.checks.outbox, { pending: 0, dead: 1 });
  } finally {
    console.error = error;
  }
});

test('nurseChannel lists the channels that can really reach the care team', async () => {
  process.env.NURSE_CHAT_ID = '-100777';
  assert.deepEqual((await ready()).body.checks.nurseChannel, { ok: false, via: [] }, 'a group id alone is not a channel: the bot is off');
  telegram.useBot(h.makeBot().bot);
  assert.deepEqual((await ready()).body.checks.nurseChannel, { ok: true, via: ['telegram'] });
  Object.assign(process.env, { NURSE_PHONE: '+14045550199', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_SMS_FROM: '+15550001111' });
  assert.deepEqual((await ready()).body.checks.nurseChannel, { ok: true, via: ['telegram', 'sms'] });
  delete process.env.NURSE_CHAT_ID;
  assert.deepEqual((await ready()).body.checks.nurseChannel, { ok: true, via: ['sms'] });
});

test('telegram reports how updates arrive, and flags a refused webhook or a dead poller', async () => {
  const quiet = async (fn) => {
    const saved = [console.log, console.warn, console.error];
    console.log = console.warn = console.error = () => {};
    try {
      return await fn();
    } finally {
      [console.log, console.warn, console.error] = saved;
    }
  };
  const { bot } = h.makeBot();
  telegram.useBot(bot);
  bot.start = async () => {};
  await telegram.launch(bot, { mode: 'polling' });
  assert.deepEqual((await ready()).body.checks.telegram, { ok: true, enabled: true, mode: 'polling' });
  await quiet(() => telegram.launch(bot, { mode: 'webhook', url: 'https://hb.example.org/webhooks/telegram', secret: 's' }));
  assert.deepEqual((await ready()).body.checks.telegram, { ok: true, enabled: true, mode: 'webhook' });
  await quiet(() => telegram.launch(bot, { mode: 'refused', reason: 'TELEGRAM_WEBHOOK_SECRET is required in production' }));
  const refused = await ready();
  assert.deepEqual(refused.body.checks.telegram, { ok: false, enabled: true, mode: 'refused' });
  assert.equal(refused.status, 200, 'a broken channel degrades; it does not take the instance out');
});

test('scheduler: off until started, then running with job counts', async () => {
  const off = (await ready()).body.checks.scheduler;
  assert.equal(off.ok, false);
  assert.equal(off.running, false);
  assert.equal(off.secondsSinceTick, null);

  await jobs.start({ intervalMs: 60_000 });
  const on = (await ready()).body.checks.scheduler;
  assert.equal(on.ok, true);
  assert.equal(on.running, true);
  assert.equal(on.secondsSinceTick, 0);
  assert.ok(on.pending > 0, 'the next check-ins are planned');
  assert.equal(on.failed, 0);

  store.collection('jobs')[0].status = 'failed';
  assert.equal((await ready()).body.checks.scheduler.failed, 1);
  jobs.stop();
  assert.equal((await ready()).body.checks.scheduler.running, false);
});

test('scheduler: a loop that stopped ticking is not ok', () => {
  assert.deepEqual(Object.keys(jobs.status()), ['running', 'intervalMs', 'msSinceTick']);
  const ok = readiness.schedulerOk;
  assert.equal(ok({ running: true, intervalMs: 30_000, msSinceTick: 0 }), true);
  assert.equal(ok({ running: true, intervalMs: 30_000, msSinceTick: 90_000 }), true, 'three intervals is the edge');
  assert.equal(ok({ running: true, intervalMs: 30_000, msSinceTick: 90_001 }), false, 'stuck');
  assert.equal(ok({ running: false, intervalMs: 0, msSinceTick: null }), false, 'never started');
  assert.equal(ok({ running: false, intervalMs: 0, msSinceTick: 5 }), false, 'started without a loop (tests)');
});

// ---------- configWarnings ----------
const CLEAN = {
  NODE_ENV: 'production',
  API_TOKEN: 'x',
  CORS_ORIGIN: 'https://dash.example.org',
  TELEGRAM_BOT_TOKEN: '1:abc',
  NURSE_CHAT_ID: '-100777',
  TWILIO_ACCOUNT_SID: 'AC1',
  TWILIO_AUTH_TOKEN: 't',
  TWILIO_SMS_FROM: '+15550001111',
  PUBLIC_URL: 'https://hb.example.org',
  FHIR_BASE_URL: 'https://fhir.hospital.example.org/r4',
};
const codes = (env) => readiness.configWarnings(env).map((w) => w.code);

test('a clean production config has no warnings', () => {
  assert.deepEqual(readiness.configWarnings(CLEAN), []);
});

test('each misconfiguration gets exactly one warning, with a message that names the setting', () => {
  const cases = [
    [{ API_TOKEN: undefined }, 'api_token_unset', /API_TOKEN/],
    [{ API_TOKEN: '   ' }, 'api_token_unset', /API_TOKEN/],
    [{ CORS_ORIGIN: undefined }, 'cors_origin_unset', /CORS_ORIGIN/],
    [{ PUBLIC_URL: undefined }, 'twilio_public_url_unset', /PUBLIC_URL.*403|403.*PUBLIC_URL/s],
    [{ NURSE_CHAT_ID: undefined }, 'nurse_channel_unset', /NURSE_CHAT_ID \/ NURSE_PHONE/],
    [{ FHIR_BASE_URL: undefined }, 'fhir_public_sandbox', /FHIR_BASE_URL/],
    [{ FHIR_BASE_URL: 'https://hapi.fhir.org/baseR4' }, 'fhir_public_sandbox', /public HAPI sandbox/],
  ];
  for (const [patch, code, message] of cases) {
    const found = readiness.configWarnings({ ...CLEAN, ...patch });
    assert.deepEqual(found.map((w) => w.code), [code], JSON.stringify(patch));
    assert.match(found[0].message, message);
  }
});

test('production-only warnings stay quiet in development', () => {
  const dev = { ...CLEAN, NODE_ENV: 'development', CORS_ORIGIN: undefined, FHIR_BASE_URL: undefined };
  assert.deepEqual(codes(dev), []);
  assert.match(readiness.configWarnings({ ...dev, PUBLIC_URL: undefined })[0].message, /ngrok or a proxy/, 'in dev a missing PUBLIC_URL is a softer warning');
});

test('PUBLIC_URL only matters once Twilio is configured', () => {
  assert.deepEqual(codes({ ...CLEAN, TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined, TWILIO_SMS_FROM: undefined, PUBLIC_URL: undefined }), []);
});

test('a nurse channel that points at an unconfigured service is flagged', () => {
  const noBot = { ...CLEAN, TELEGRAM_BOT_TOKEN: undefined };
  assert.deepEqual(codes(noBot), ['nurse_channel_unusable']);
  assert.match(readiness.configWarnings(noBot)[0].message, /NURSE_CHAT_ID needs TELEGRAM_BOT_TOKEN/);
  const phoneOnly = { ...CLEAN, NURSE_CHAT_ID: undefined, NURSE_PHONE: '+14045550199' };
  assert.deepEqual(codes(phoneOnly), [], 'a phone with Twilio configured is a working channel');
  assert.deepEqual(codes({ ...phoneOnly, TWILIO_SMS_FROM: undefined }), ['nurse_channel_unusable']);
  assert.deepEqual(codes({ ...noBot, NURSE_PHONE: '+14045550199' }), [], 'the phone fallback still reaches them');
});

test('an empty environment (first local run) warns about the open API and the missing nurse channel only', () => {
  assert.deepEqual(codes({}), ['api_token_unset', 'nurse_channel_unset']);
});

test('several problems at once are all reported, in a stable order', () => {
  assert.deepEqual(codes({ NODE_ENV: 'production', TWILIO_AUTH_TOKEN: 't' }), ['api_token_unset', 'cors_origin_unset', 'twilio_public_url_unset', 'nurse_channel_unset', 'fhir_public_sandbox']);
});

test('configWarnings is pure: it reads the env it is given, not process.env', () => {
  process.env.API_TOKEN = 'set-in-process';
  assert.deepEqual(codes({ ...CLEAN, API_TOKEN: undefined }), ['api_token_unset']);
  const frozen = Object.freeze({ ...CLEAN });
  assert.deepEqual(readiness.configWarnings(frozen), []);
});

test('fhir.usesPublicSandbox: unset or the HAPI host is the sandbox; anything else is not', async () => {
  const { usesPublicSandbox } = await import('../src/integrations/fhir.js');
  assert.equal(usesPublicSandbox({}), true);
  assert.equal(usesPublicSandbox({ FHIR_BASE_URL: 'https://hapi.fhir.org/baseR4/' }), true);
  assert.equal(usesPublicSandbox({ FHIR_BASE_URL: 'https://fhir.hospital.example.org/r4' }), false);
  assert.equal(usesPublicSandbox({ FHIR_BASE_URL: 'not a url' }), false);
});
