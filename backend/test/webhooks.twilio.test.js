// K5: POST /webhooks/twilio/{sms,whatsapp}. Real express app on a random port; Twilio's
// REST API and media downloads are mocked (local requests pass through to the real fetch).
import { test, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-webhooks-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, i18n, twilio, server, base;

before(async () => {
  store = await import('../src/store.js');
  i18n = await import('../src/core/i18n.js');
  twilio = await import('../src/channels/twilio.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const realFetch = globalThis.fetch;
const TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: 'secret',
  TWILIO_SMS_FROM: '+15550001111',
  TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
};
let posts;
let twilioStatus;
let mediaFetches;

beforeEach(() => {
  store.reset();
  posts = [];
  mediaFetches = [];
  twilioStatus = 201;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith(base)) return realFetch(url, init);
    if (u.startsWith('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json')) {
      posts.push(Object.fromEntries(new URLSearchParams(init.body)));
      return Response.json({ sid: 'SM1' }, { status: twilioStatus });
    }
    if (u.startsWith('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM1/Media/')) {
      mediaFetches.push({ url: u, headers: init.headers });
      return new Response(Buffer.from('media-bytes'));
    }
    throw new Error(`unexpected fetch ${u}`);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(TWILIO_ENV)) delete process.env[k];
});

const twilioOn = () => Object.assign(process.env, TWILIO_ENV);
const PHONE = '+14045550100';

async function post(channel, params, headers = {}) {
  const res = await fetch(`${base}/webhooks/twilio/${channel}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(params),
  });
  return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
}

const sms = (Body, extra = {}) => post('sms', { From: PHONE, Body, ...extra });
const messagesIn = (xml) => [...xml.matchAll(/<Message>([\s\S]*?)<\/Message>/g)].map((m) => m[1]);
const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

// ---------- JOIN ----------
test('JOIN <CODE> links the phone to the patient and welcomes in her language', async () => {
  const res = await sms('JOIN GARCIA1');
  assert.equal(res.status, 200);
  assert.match(res.type, /text\/xml/);
  const p = store.getPatient('p1');
  assert.equal(p.phone, PHONE);
  assert.equal(p.channel, 'sms');
  assert.deepEqual(messagesIn(res.body).map(unescape), [i18n.t('es', 'welcome_patient', { name: 'Maria' })], 'no Twilio creds: reply rides in TwiML');
  assert.ok(store.listMessages('p1').some((m) => m.channel === 'sms' && m.direction === 'out'));
});

test('join is case-insensitive and CG_ links the caregiver phone', async () => {
  await post('whatsapp', { From: `whatsapp:${PHONE}`, Body: 'join cg_garcia1' });
  const p = store.getPatient('p1');
  assert.equal(p.caregiver.phone, PHONE);
  assert.equal(p.caregiver.channel, 'whatsapp');
  assert.equal(p.phone ?? null, null);
});

test('JOIN DEMO_ES enrolls a demo patient on this phone and starts the check-in', async () => {
  const res = await sms('JOIN DEMO_ES');
  const demo = store.listPatients().find((p) => p.source === 'demo');
  assert.equal(demo.phone, PHONE);
  assert.equal(demo.language, 'es');
  assert.equal(demo.checkin.state, 'redflags');
  assert.ok(unescape(messagesIn(res.body).at(-1)).startsWith(i18n.t('es', 'ask_redflags')));
});

test('re-JOINing moves the phone: one phone = one person', async () => {
  await sms('JOIN GARCIA1');
  await sms('JOIN JOHNSON1');
  assert.equal(store.getPatient('p1').phone, null);
  assert.equal(store.getPatientByCode('JOHNSON1').phone, PHONE);
});

test('JOIN with an unknown code does not link', async () => {
  await sms('JOIN GARCIA1');
  const res = await sms('JOIN NOPE');
  assert.deepEqual(messagesIn(res.body).map(unescape), [i18n.t('en', 'unknown_code_sms')]);
  assert.equal(store.getPatient('p1').phone, PHONE, 'existing link kept');
});

test('an unlinked phone is asked for a code and nothing reaches the core', async () => {
  const res = await sms('hola');
  const [text] = messagesIn(res.body).map(unescape);
  assert.equal(text, i18n.t('en', 'unknown_code_sms'));
  assert.match(text, /JOIN/);
  assert.doesNotMatch(text, /\/start/, 'no Telegram-only instructions over SMS');
  assert.ok(store.listMessages('p1').every((m) => m.direction !== 'in'));
});

test('a request without From is rejected', async () => {
  assert.equal((await post('sms', { Body: 'hi' })).status, 400);
});

// ---------- inbound -> reply ----------
test('inbound text reaches handleInbound and replies go out over the REST API with empty TwiML', async () => {
  await sms('JOIN GARCIA1');
  twilioOn();
  const res = await signedSms('hola');
  assert.equal(res.status, 200);
  assert.equal(messagesIn(res.body).length, 0, 'empty TwiML');
  assert.equal(res.body, '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  assert.ok(posts.at(-1).Body.startsWith(i18n.t('es', 'ask_redflags')));
  assert.ok(posts.every((p) => p.To === PHONE && p.From === '+15550001111'));
  const inbound = store.listMessages('p1').filter((m) => m.direction === 'in').at(-1);
  assert.equal(inbound.text, 'hola');
  assert.equal(inbound.channel, 'sms');
});

test('a numbered answer becomes that button\'s data', async () => {
  await sms('JOIN GARCIA1');
  await sms('hola'); // starts the check-in -> red-flag screen
  await sms('no'); // -> weight question
  const breath = await sms('176');
  assert.match(unescape(messagesIn(breath.body).at(-1)), /1️⃣ 😊 Normal/);
  await sms('2');
  assert.equal(store.getPatient('p1').checkin.answers.breath, 'exertion');
  const inbound = store.listMessages('p1').filter((m) => m.direction === 'in').at(-1);
  assert.equal(inbound.text, i18n.t('es', 'breath_exertion'), 'the dashboard shows the label, not "2"');
});

test('WhatsApp replies are addressed to whatsapp: numbers', async () => {
  await post('whatsapp', { From: `whatsapp:${PHONE}`, Body: 'JOIN GARCIA1' });
  twilioOn();
  posts = [];
  const res = await signed('whatsapp', { From: `whatsapp:${PHONE}`, Body: 'hola' });
  assert.equal(res.status, 200);
  assert.ok(posts.length >= 2);
  assert.ok(posts.every((p) => p.To === `whatsapp:${PHONE}` && p.From === 'whatsapp:+14155238886'));
});

test('if the REST API fails, the remaining replies come back as TwiML instead', async () => {
  await sms('JOIN GARCIA1');
  twilioOn();
  twilioStatus = 500;
  const err = console.error;
  console.error = () => {};
  let res;
  try {
    res = await signedSms('hola');
  } finally {
    console.error = err;
  }
  const texts = messagesIn(res.body).map(unescape);
  assert.ok(texts.at(-1).startsWith(i18n.t('es', 'ask_redflags')));
  assert.ok(texts.length >= 2, 'greeting + question');
});

test('an urgent reply keeps its emergency styling when it rides back in TwiML', async () => {
  await sms('JOIN GARCIA1');
  const viaSms = await sms('tengo dolor de pecho');
  assert.deepEqual(messagesIn(viaSms.body).map(unescape), [i18n.t('es', 'red_interrupt')], 'SMS: 🚨, no markup');

  store.reset();
  await post('whatsapp', { From: `whatsapp:${PHONE}`, Body: 'JOIN GARCIA1' });
  const viaWhatsapp = await post('whatsapp', { From: `whatsapp:${PHONE}`, Body: 'tengo dolor de pecho' });
  assert.deepEqual(messagesIn(viaWhatsapp.body).map(unescape), [`*${i18n.t('es', 'red_interrupt')}*`], 'WhatsApp: bold, like the REST path');
});

// ---------- retries ----------
// Twilio posts a message again (same MessageSid) when our answer was slow or lost. The core already
// handles the message once; the webhook used to send the replies out a second time.
test('a retry of the same MessageSid does not send the replies again', async () => {
  await sms('JOIN GARCIA1');
  twilioOn();
  await signedSms('hola', { MessageSid: 'SM-retry-1' });
  const sentOnce = posts.length;
  assert.ok(sentOnce > 0);
  const again = await signedSms('hola', { MessageSid: 'SM-retry-1' });
  assert.equal(again.status, 200);
  assert.equal(posts.length, sentOnce, 'the patient did not get a second copy');
  assert.equal(store.listMessages('p1').filter((m) => m.direction === 'in' && m.text === 'hola').length, 1);
});

test('two deliveries of one MessageSid racing each other send one set of replies', async () => {
  await sms('JOIN GARCIA1');
  twilioOn();
  await Promise.all([signedSms('hola', { MessageSid: 'SM-retry-2' }), signedSms('hola', { MessageSid: 'SM-retry-2' })]);
  assert.equal(posts.filter((p) => p.Body.startsWith(i18n.t('es', 'ask_redflags'))).length, 1);
});

test('with no REST credentials a retry is answered with the same TwiML (Twilio uses whichever answer arrives)', async () => {
  await sms('JOIN GARCIA1');
  const first = await sms('hola', { MessageSid: 'SM-retry-3' });
  const again = await sms('hola', { MessageSid: 'SM-retry-3' });
  assert.ok(messagesIn(first.body).length > 0);
  assert.equal(again.body, first.body);
});

test('a retried JOIN DEMO enrolls one demo patient, not two', async () => {
  const before = store.listPatients().length;
  await sms('JOIN DEMO_ES', { MessageSid: 'SM-retry-4' });
  await sms('JOIN DEMO_ES', { MessageSid: 'SM-retry-4' });
  assert.equal(store.listPatients().length, before + 1);
});

test('a different MessageSid with the same words is a new message', async () => {
  await sms('JOIN GARCIA1');
  await sms('gracias', { MessageSid: 'SM-new-1' });
  await sms('gracias', { MessageSid: 'SM-new-2' });
  assert.equal(store.listMessages('p1').filter((m) => m.direction === 'in' && m.text === 'gracias').length, 2);
});

// ---------- media ----------
test('an MMS / WhatsApp image is downloaded with Twilio auth and handed to the core as a photo', async () => {
  await sms('JOIN GARCIA1');
  twilioOn();
  await signedSms('', { NumMedia: '1', MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM1/Media/img1', MediaContentType0: 'image/jpeg' });
  assert.equal(mediaFetches[0].headers.Authorization, `Basic ${Buffer.from('AC123:secret').toString('base64')}`);
  const audit = store.listAudit('p1').find((e) => e.type === 'photo_received');
  assert.equal(audit.data.mime, 'image/jpeg');
});

// The text sent with a picture is the patient speaking; it used to be dropped whenever media was attached.
test('an emergency written next to an MMS picture gets the 911 reply and a RED alert', async () => {
  await sms('JOIN GARCIA1');
  const res = await sms('me duele mucho el pecho', { NumMedia: '1', MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM1/Media/img1', MediaContentType0: 'image/jpeg' });
  assert.equal(store.listAlerts('p1').filter((a) => a.tier === 'RED').length, 1);
  const replies = messagesIn(res.body).map(unescape);
  assert.match(replies.at(-1), /^🚨/);
  assert.ok(!replies.includes(i18n.t('es', 'photo_received')), 'no "thanks for the photo" next to a 911 instruction');
});

test('calm text next to an MMS picture is read as a message and the photo is still saved', async () => {
  await sms('JOIN GARCIA1');
  await sms('mi cena de hoy', { NumMedia: '1', MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM1/Media/img1', MediaContentType0: 'image/jpeg' });
  const inbound = store.listMessages('p1').filter((m) => m.direction === 'in').map((m) => m.text);
  assert.deepEqual(inbound, ['mi cena de hoy', '[photo]']);
  assert.ok(store.listAudit('p1').some((e) => e.type === 'photo_received'));
});

test('text next to a picture that could not be downloaded is still read', async () => {
  await sms('JOIN GARCIA1');
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).startsWith('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM1/Media/') ? new Response('gone', { status: 404 }) : inner(url, init));
  const err = console.error;
  console.error = () => {};
  try {
    await sms('me duele mucho el pecho', { NumMedia: '1', MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM1/Media/img2', MediaContentType0: 'image/jpeg' });
  } finally {
    console.error = err;
  }
  assert.equal(store.listAlerts('p1').filter((a) => a.tier === 'RED').length, 1);
});

test('a failed image download tells the patient instead of reaching the core', async () => {
  await sms('JOIN GARCIA1');
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).startsWith('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM1/Media/') ? new Response('gone', { status: 404 }) : inner(url, init));
  const err = console.error;
  console.error = () => {};
  let res;
  try {
    res = await sms('', { NumMedia: '1', MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM1/Media/img2', MediaContentType0: 'image/jpeg' });
  } finally {
    console.error = err;
  }
  assert.deepEqual(messagesIn(res.body).map(unescape), [i18n.t('es', 'photo_failed')]);
  assert.ok(!store.listAudit('p1').some((e) => e.type === 'photo_received'));
});

const AUDIO = { NumMedia: '1', MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM1/Media/a1', MediaContentType0: 'audio/ogg' };

test('a voice note with no transcription key asks the patient to type, says what to do in an emergency, and is logged', async () => {
  await sms('JOIN GARCIA1');
  const res = await sms('', AUDIO);
  const [reply] = messagesIn(res.body).map(unescape);
  assert.ok(reply.startsWith(i18n.t('es', 'voice_unavailable')));
  assert.ok(reply.includes(i18n.t('es', 'safety_net_911')), 'nobody heard the note');
  const log = store.listMessages('p1');
  assert.equal(log.filter((m) => m.direction === 'in').at(-1).text, '[voice note]');
  assert.equal(log.filter((m) => m.direction === 'out').at(-1).text, reply);
});

test('during a RED lock a voice note nobody could hear repeats "call 911" and lands on the RED alert', async () => {
  await sms('JOIN GARCIA1');
  await sms('me duele mucho el pecho');
  const res = await sms('', AUDIO);
  assert.match(messagesIn(res.body).map(unescape).at(-1), /^🚨.*911/s);
  const reds = store.listAlerts('p1').filter((x) => x.tier === 'RED');
  assert.equal(reds.length, 1);
  assert.ok(reds[0].reasons.some((r) => /messaged again/.test(r)));
});

test('a video, or a message with no words at all, is shown to the nurse as what it was and still gets an answer', async () => {
  await sms('JOIN GARCIA1');
  const video = await sms('', { NumMedia: '1', MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM1/Media/v1', MediaContentType0: 'video/mp4' });
  assert.equal(messagesIn(video.body).length, 1);
  const inbound = () => store.listMessages('p1').filter((m) => m.direction === 'in').at(-1).text;
  assert.equal(inbound(), '[attachment]');
  const empty = await post('whatsapp', { From: `whatsapp:${PHONE}`, Body: '', Latitude: '33.77', Longitude: '-84.39' });
  assert.equal(messagesIn(empty.body).length, 1);
  assert.equal(inbound(), '[no text]');
});

// ---------- signature ----------
function signed(channel, params) {
  const url = `${base}/webhooks/twilio/${channel}`;
  return post(channel, params, { 'X-Twilio-Signature': twilio.signature(TWILIO_ENV.TWILIO_AUTH_TOKEN, url, params) });
}
const signedSms = (Body, extra = {}) => signed('sms', { From: PHONE, Body, ...extra });

test('signature check on: a valid signature passes', async () => {
  twilioOn();
  const res = await signedSms('JOIN GARCIA1');
  assert.equal(res.status, 200);
  assert.equal(store.getPatient('p1').phone, PHONE);
});

test('signature check on: a missing or forged signature is rejected with 403', async () => {
  twilioOn();
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal((await sms('JOIN GARCIA1')).status, 403);
    assert.equal((await post('sms', { From: PHONE, Body: 'JOIN GARCIA1' }, { 'X-Twilio-Signature': 'forged=' })).status, 403);
    // Signed for different params (tampered body)
    const url = `${base}/webhooks/twilio/sms`;
    const sig = twilio.signature('secret', url, { From: PHONE, Body: 'hola' });
    assert.equal((await post('sms', { From: PHONE, Body: 'JOIN GARCIA1' }, { 'X-Twilio-Signature': sig })).status, 403);
  } finally {
    console.warn = warn;
  }
  assert.equal(store.getPatient('p1').phone ?? null, null);
});

test('signature check honours PUBLIC_URL (ngrok) when set', async () => {
  twilioOn();
  process.env.PUBLIC_URL = 'https://abc.ngrok.app/';
  try {
    const params = { From: PHONE, Body: 'JOIN GARCIA1' };
    const sig = twilio.signature('secret', 'https://abc.ngrok.app/webhooks/twilio/sms', params);
    assert.equal((await post('sms', params, { 'X-Twilio-Signature': sig })).status, 200);
  } finally {
    delete process.env.PUBLIC_URL;
  }
});

test('signature check off (no auth token): unsigned requests are accepted', async () => {
  assert.equal((await sms('JOIN GARCIA1')).status, 200);
});

test('GET /webhooks reports which channels are live', async () => {
  const off = await (await fetch(`${base}/webhooks`)).json();
  assert.deepEqual(off, { ok: true, sms: false, whatsapp: false, signatureCheck: false });
  twilioOn();
  const on = await (await fetch(`${base}/webhooks`)).json();
  assert.deepEqual(on, { ok: true, sms: true, whatsapp: true, signatureCheck: true });
});
