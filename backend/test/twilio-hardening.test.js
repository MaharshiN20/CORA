// Phase 1: webhooks fail closed in production; media downloads can't be turned into SSRF.
import { test, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-twhard-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, twilio, i18n, resilience, server, base;
const realFetch = globalThis.fetch;
const ENV = { TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'secret', TWILIO_SMS_FROM: '+15550001111' };
const PHONE = '+14045550100';
const MEDIA = 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM1/Media/ME1';
let fetched;
let mediaResponse;

before(async () => {
  store = await import('../src/store.js');
  twilio = await import('../src/channels/twilio.js');
  i18n = await import('../src/core/i18n.js');
  resilience = await import('../src/channels/resilience.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());
beforeEach(() => {
  store.reset();
  fetched = [];
  mediaResponse = () => new Response(Buffer.from('jpeg-bytes'));
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith(base)) return realFetch(url, init);
    fetched.push({ url: u, headers: init.headers, body: init.body ? String(init.body) : '' });
    if (u.includes('/Media/')) return mediaResponse();
    return Response.json({ sid: 'SM1' }, { status: 201 });
  };
  process.env.ALLOW_RELINK = '1';
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of [...Object.keys(ENV), 'NODE_ENV', 'PUBLIC_URL', 'TWILIO_SKIP_VERIFY']) delete process.env[k];
});

async function post(params, headers = {}) {
  const res = await fetch(`${base}/webhooks/twilio/sms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: await res.text() };
}
const quiet = async (fn) => {
  const warn = console.warn;
  const err = console.error;
  console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.error = err;
  }
};
// With Twilio configured, replies go out over the REST API rather than in the TwiML response.
const sentText = () => fetched.filter((f) => f.url.includes('/Messages.json')).map((f) => new URLSearchParams(f.body).get('Body')).join(' ');
const signedPost = (params, url = `${base}/webhooks/twilio/sms`) => post(params, { 'X-Twilio-Signature': twilio.signature('secret', url, params) });

test('production without TWILIO_AUTH_TOKEN: webhooks refuse everything (fail closed)', async () => {
  process.env.NODE_ENV = 'production';
  const res = await quiet(() => post({ From: PHONE, Body: 'JOIN GARCIA1' }));
  assert.equal(res.status, 403);
  assert.equal(store.getPatient('p1').phone ?? null, null, 'nothing was linked');
});

test('TWILIO_SKIP_VERIFY=1 is the explicit opt-out in production', async () => {
  process.env.NODE_ENV = 'production';
  process.env.TWILIO_SKIP_VERIFY = '1';
  assert.equal((await post({ From: PHONE, Body: 'JOIN GARCIA1' })).status, 200);
});

test('production with a token but no PUBLIC_URL: refused; with PUBLIC_URL and a good signature: accepted', async () => {
  process.env.NODE_ENV = 'production';
  Object.assign(process.env, ENV);
  const params = { From: PHONE, Body: 'JOIN GARCIA1' };
  assert.equal((await quiet(() => signedPost(params))).status, 403);
  process.env.PUBLIC_URL = 'https://hb.example.org';
  const ok = await signedPost(params, 'https://hb.example.org/webhooks/twilio/sms');
  assert.equal(ok.status, 200);
});

test('non-production without a token still accepts unsigned requests (local dev, tests)', async () => {
  assert.equal((await post({ From: PHONE, Body: 'JOIN GARCIA1' })).status, 200);
});

test('MediaUrl0 on any host other than api.twilio.com is never fetched and never gets credentials', async () => {
  await post({ From: PHONE, Body: 'JOIN GARCIA1' });
  Object.assign(process.env, ENV);
  for (const evil of ['https://evil.example/x', 'http://api.twilio.com/x', 'https://api.twilio.com.evil.example/x', 'http://169.254.169.254/latest/meta-data', 'not a url']) {
    fetched.length = 0;
    const params = { From: PHONE, Body: '', NumMedia: '1', MediaUrl0: evil, MediaContentType0: 'image/jpeg' };
    const res = await quiet(() => signedPost(params));
    assert.equal(res.status, 200);
    assert.ok(!fetched.some((f) => f.url === evil || f.url.startsWith(evil)), `${evil} must not be fetched`);
    assert.ok(!fetched.some((f) => f.headers?.Authorization && !f.url.startsWith('https://api.twilio.com/')), 'credentials only go to Twilio');
    assert.ok(sentText().includes(i18n.t('es', 'photo_failed')), 'patient is told to resend');
  }
});

test('an oversized media body is cut off at the cap, not buffered', async () => {
  await post({ From: PHONE, Body: 'JOIN GARCIA1' });
  Object.assign(process.env, ENV);
  let pulled = 0;
  mediaResponse = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          pulled++;
          if (pulled > 50) return controller.close();
          controller.enqueue(new Uint8Array(1024 * 1024)); // 1 MB chunks, no content-length
        },
      }),
    );
  const params = { From: PHONE, Body: '', NumMedia: '1', MediaUrl0: MEDIA, MediaContentType0: 'image/jpeg' };
  await signedPost(params);
  assert.ok(sentText().includes(i18n.t('es', 'file_too_large')));
  assert.ok(pulled < 20, `stopped reading early (pulled ${pulled} MB of 50)`);
  assert.ok(!store.listAudit('p1').some((e) => e.type === 'photo_received'));
});

test('readBodyCapped: honours content-length, streams, and passes small bodies through', async () => {
  const big = new Response(Buffer.alloc(100), { headers: { 'content-length': '100' } });
  assert.equal(await resilience.readBodyCapped(big, 50), null);
  assert.deepEqual(await resilience.readBodyCapped(new Response(Buffer.from('abc')), 50), Buffer.from('abc'));
  assert.equal(await resilience.readBodyCapped(new Response(Buffer.alloc(100)), 50), null);
});
