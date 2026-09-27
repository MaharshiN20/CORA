// K5: numbered options, the Twilio adapters, and adapter routing/fallback. Fetch is mocked.
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-channels-adapters-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, clock, options, twilio, channels;

before(async () => {
  store = await import('../src/store.js');
  clock = await import('../src/core/clock.js');
  options = await import('../src/channels/options.js');
  twilio = await import('../src/channels/twilio.js');
  channels = await import('../src/channels/index.js');
});

const realFetch = globalThis.fetch;
const TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: 'secret',
  TWILIO_SMS_FROM: '+15550001111',
  TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
};
let posts;
let twilioStatus;

beforeEach(() => {
  store.reset();
  Object.assign(process.env, TWILIO_ENV);
  posts = [];
  twilioStatus = 201;
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.startsWith('https://api.twilio.com/')) {
      posts.push({ url, headers: init.headers, params: Object.fromEntries(new URLSearchParams(init.body)) });
      return Response.json(twilioStatus < 300 ? { sid: 'SM1' } : { message: 'The To number is not verified' }, { status: twilioStatus });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(TWILIO_ENV)) delete process.env[k];
  channels.resetAdapters();
});

const BREATH = {
  text: '¿Cómo está su respiración hoy?',
  buttons: [[{ label: '😊 Normal', data: 'ci:breath:normal' }], [{ label: '😮‍💨 Peor al caminar', data: 'ci:breath:exertion' }], [{ label: '🚨 Difícil aun en reposo', data: 'ci:breath:rest' }]],
};

// ---------- numbered options ----------
test('normalizePhone strips whatsapp: and formatting', () => {
  assert.equal(options.normalizePhone('whatsapp:+1 (404) 555-0100'), '+14045550100');
  assert.equal(options.normalizePhone('4045550100'), '4045550100');
  assert.equal(options.normalizePhone(''), null);
  assert.equal(options.normalizePhone(undefined), null);
});

test('buttons render as numbered lines; text without buttons is unchanged', () => {
  const { body, options: opts } = options.renderNumbered(BREATH);
  assert.equal(body, `${BREATH.text}\n\n1️⃣ 😊 Normal\n2️⃣ 😮‍💨 Peor al caminar\n3️⃣ 🚨 Difícil aun en reposo`);
  assert.deepEqual(opts.map((o) => o.data), ['ci:breath:normal', 'ci:breath:exertion', 'ci:breath:rest']);
  assert.deepEqual(options.renderNumbered({ text: 'hi' }), { body: 'hi', options: [] });
});

test('a remembered menu maps "2" (and "2." / " 2 ") to that button, per phone', () => {
  options.remember('+14045550100', BREATH.buttons.flat());
  assert.equal(options.resolve('whatsapp:+14045550100', '2').data, 'ci:breath:exertion');
  assert.equal(options.resolve('+14045550100', ' 2. ').data, 'ci:breath:exertion');
  assert.equal(options.resolve('+14045550100', '1)').data, 'ci:breath:normal');
  assert.equal(options.resolve('+19995550000', '2'), null, 'other phones have no menu');
});

test('numbers out of range, weights and words are not treated as options', () => {
  options.remember('+14045550100', BREATH.buttons.flat());
  for (const text of ['0', '4', '176', '95', 'dos', '', '2 lbs']) assert.equal(options.resolve('+14045550100', text), null, text);
});

test('the newest menu wins, and menus expire after a day', () => {
  options.remember('+14045550100', BREATH.buttons.flat());
  options.remember('+14045550100', [{ label: 'Sí', data: 'ci:diu:yes' }]);
  assert.equal(options.resolve('+14045550100', '1').data, 'ci:diu:yes');
  assert.equal(options.resolve('+14045550100', '2'), null);
  clock.advance(25 * clock.HOUR);
  assert.equal(options.resolve('+14045550100', '1'), null);
});

// ---------- Twilio adapters ----------
test('sms adapter posts to the Twilio REST API with basic auth and numbered options', async () => {
  await twilio.sms.send('+14045550100', BREATH);
  const [post] = posts;
  assert.equal(post.url, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
  assert.equal(post.headers.Authorization, `Basic ${Buffer.from('AC123:secret').toString('base64')}`);
  assert.equal(post.params.To, '+14045550100');
  assert.equal(post.params.From, '+15550001111');
  assert.match(post.params.Body, /1️⃣ 😊 Normal/);
  assert.equal(options.resolve('+14045550100', '3').data, 'ci:breath:rest', 'menu remembered after sending');
});

test('whatsapp adapter uses whatsapp: addresses and bolds urgent text', async () => {
  await twilio.whatsapp.send('+14045550100', { text: 'LLAME AL 911', urgent: true });
  const { params } = posts[0];
  assert.equal(params.To, 'whatsapp:+14045550100');
  assert.equal(params.From, 'whatsapp:+14155238886');
  assert.equal(params.Body, '*🚨 LLAME AL 911*');
  assert.equal(params.MediaUrl, undefined);
});

test('urgent SMS gets the 🚨 but no markup', async () => {
  await twilio.sms.send('+14045550100', { text: 'Call 911', urgent: true });
  assert.equal(posts[0].params.Body, '🚨 Call 911');
});

test('whatsapp voice replies attach a TTS audio url', async () => {
  await twilio.whatsapp.send('+14045550100', { text: 'Hola Maria', voice: true }, { language: 'es' });
  const media = new URL(posts[0].params.MediaUrl);
  assert.equal(media.searchParams.get('tl'), 'es');
  assert.equal(media.searchParams.get('q'), 'Hola Maria');
});

test('very long SMS bodies are cut to Twilio\'s 1600-character limit', async () => {
  await twilio.sms.send('+14045550100', { text: 'x'.repeat(2000) });
  assert.equal(posts[0].params.Body.length, 1600);
});

test('a Twilio HTTP error throws with its message (the router turns it into false)', async () => {
  twilioStatus = 400;
  await assert.rejects(() => twilio.sms.send('+14045550100', { text: 'hi' }), /400: The To number is not verified/);
});

test('adapters are disabled without credentials or a From number', () => {
  assert.equal(twilio.sms.isEnabled(), true);
  delete process.env.TWILIO_SMS_FROM;
  assert.equal(twilio.sms.isEnabled(), false);
  assert.equal(twilio.whatsapp.isEnabled(), true);
  delete process.env.TWILIO_AUTH_TOKEN;
  assert.equal(twilio.whatsapp.isEnabled(), false);
});

test('webhook signatures follow Twilio\'s HMAC-SHA1 scheme', () => {
  // Test vector from the official twilio-node library (webhooks.spec.js).
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const params = { CallSid: 'CA1234567890ABCDE', Caller: '+14158675309', Digits: '1234', From: '+14158675309', To: '+18005551212' };
  assert.equal(twilio.signature('12345', url, params), 'RSOYDt4T1cUTdK1PDd93/VVr8B8=');
  assert.equal(twilio.validSignature('12345', 'RSOYDt4T1cUTdK1PDd93/VVr8B8=', url, params), true);
  assert.equal(twilio.validSignature('12345', 'nope', url, params), false);
  assert.equal(twilio.validSignature('12345', undefined, url, params), false);
});

// ---------- routing ----------
function fake(name, { enabled = true, fail = false } = {}) {
  const sent = [];
  return {
    sent,
    adapter: {
      name,
      isEnabled: () => enabled,
      send: async (address, reply) => {
        if (fail) throw new Error(`${name} down`);
        sent.push({ address, reply });
      },
    },
  };
}

const quiet = async (fn) => {
  const err = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = err;
  }
};

test('the patient\'s preferred channel is used first', async () => {
  const tg = fake('telegram');
  const sms = fake('sms');
  channels.setAdapter('telegram', tg.adapter);
  channels.setAdapter('sms', sms.adapter);
  store.updatePatient('p1', { chatId: 4242, phone: '+14045550100', channel: 'sms' });
  assert.equal(await channels.sendToPatient(store.getPatient('p1'), { text: 'hola' }), true);
  assert.equal(sms.sent[0].address, '+14045550100');
  assert.equal(tg.sent.length, 0);
});

test('a disabled preferred channel falls back to another channel with an address', async () => {
  const tg = fake('telegram');
  channels.setAdapter('telegram', tg.adapter);
  channels.setAdapter('sms', fake('sms', { enabled: false }).adapter);
  store.updatePatient('p1', { chatId: 4242, phone: '+14045550100', channel: 'sms' });
  assert.equal(await channels.sendToPatient(store.getPatient('p1'), { text: 'hola' }), true);
  assert.equal(tg.sent[0].address, 4242);
});

test('a failing channel falls back too', async () => {
  const wa = fake('whatsapp');
  channels.setAdapter('telegram', fake('telegram', { fail: true }).adapter);
  channels.setAdapter('sms', fake('sms', { enabled: false }).adapter);
  channels.setAdapter('whatsapp', wa.adapter);
  store.updatePatient('p1', { chatId: 4242, phone: '+14045550100' });
  assert.equal(await quiet(() => channels.sendToPatient(store.getPatient('p1'), { text: 'hola' })), true);
  assert.equal(wa.sent.length, 1);
});

test('channels without an address for the person are skipped', async () => {
  const sms = fake('sms');
  channels.setAdapter('sms', sms.adapter);
  store.updatePatient('p1', { chatId: null, phone: null });
  assert.equal(await channels.sendToPatient(store.getPatient('p1'), { text: 'hola' }), false);
  assert.equal(sms.sent.length, 0);
});

test('every channel disabled or failing: false, never a throw, still logged', async () => {
  channels.setAdapter('telegram', fake('telegram', { enabled: false }).adapter);
  channels.setAdapter('sms', fake('sms', { fail: true }).adapter);
  channels.setAdapter('whatsapp', { name: 'whatsapp', isEnabled: () => { throw new Error('bad config'); }, send: async () => {} });
  store.updatePatient('p1', { chatId: 4242, phone: '+14045550100' });
  assert.equal(await quiet(() => channels.sendToPatient(store.getPatient('p1'), { text: 'hola' })), false);
  assert.equal(store.listMessages('p1').at(-1).text, 'hola');
});

test('real adapters with no Twilio env and no Telegram bot: sends return false quietly', async () => {
  for (const k of Object.keys(TWILIO_ENV)) delete process.env[k];
  store.updatePatient('p1', { chatId: 4242, phone: '+14045550100', channel: 'whatsapp' });
  assert.equal(await channels.sendToPatient(store.getPatient('p1'), { text: 'hola' }), false);
  assert.equal(posts.length, 0);
});

test('caregivers are routed by their own channel and phone', async () => {
  const sms = fake('sms');
  channels.setAdapter('sms', sms.adapter);
  const cg = store.getPatient('p1').caregiver;
  store.updatePatient('p1', { caregiver: { ...cg, phone: '+14045550199', channel: 'sms' } });
  assert.equal(await channels.sendToCaregiver(store.getPatient('p1'), { text: 'Maria needs a call' }), true);
  assert.equal(sms.sent[0].address, '+14045550199');
});

test('the real sms adapter delivers through sendToPatient end to end', async () => {
  store.updatePatient('p1', { phone: '+14045550100', channel: 'sms' });
  assert.equal(await channels.sendToPatient(store.getPatient('p1'), BREATH), true);
  assert.equal(posts[0].params.To, '+14045550100');
  assert.equal(options.resolve('+14045550100', '1').data, 'ci:breath:normal');
});
