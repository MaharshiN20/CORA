// Phase 3: a 911 message never waits on, or is garbled by, a translation; the caregiver alert is
// written in the caregiver's language.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-urgent-i18n-${process.pid}.json`);
process.env.LLM_PROVIDER = 'lmstudio';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, i18n, llm, agent;
const realFetch = globalThis.fetch;
let mode = 'good'; // good | hang | no911 | down
let calls = 0;
const SYSTEM_911 = 'Cuidado: llame al 911 ahora.';

before(async () => {
  store = await import('../src/store.js');
  i18n = await import('../src/core/i18n.js');
  llm = await import('../src/core/llm/index.js');
  agent = await import('../src/core/agent.js');
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }] }));
    if (u.endsWith('/v1/chat/completions')) {
      calls++;
      if (mode === 'hang') {
        await new Promise((r) => setTimeout(r, 8000).unref());
        return Response.json({ choices: [{ message: { content: 'late' } }] });
      }
      if (mode === 'down') return new Response('bad gateway', { status: 502 });
      const user = JSON.parse(init.body).messages.at(-1).content;
      const content = mode === 'no911' ? `긴급: ${user.replace(/911/g, 'emergencia')}` : `긴급: ${user}`;
      return Response.json({ choices: [{ message: { content } }] });
    }
    return realFetch(url, init);
  };
  await llm.detect({ force: true });
});
after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  store.reset();
  mode = 'good';
  calls = 0;
});

const URGENT = 'Call 911 now if you have chest pain. A nurse has been alerted.';

test('localizeUrgent: a working model translates, and the translation keeps "911"', async () => {
  const out = await i18n.localizeUrgent('ko', `${URGENT} unique-a`, { deadlineMs: 500 });
  assert.match(out, /^긴급/);
  assert.match(out, /911/);
});

test('localizeUrgent: a hanging model falls back to the English text within the deadline', async () => {
  mode = 'hang';
  const started = Date.now();
  const out = await i18n.localizeUrgent('ko', `${URGENT} unique-b`, { deadlineMs: 150 });
  assert.ok(Date.now() - started < 1500, `answered in ${Date.now() - started} ms, not 8 s`);
  assert.equal(out, `${URGENT} unique-b`);
});

test('localizeUrgent: a translation that dropped "911" is rejected, English wins', async () => {
  mode = 'no911';
  const out = await i18n.localizeUrgent('ko', `${URGENT} unique-c`, { deadlineMs: 500 });
  assert.equal(out, `${URGENT} unique-c`);
  assert.match(out, /911/);
});

test('localizeUrgent: model down -> English; and a failure is not cached (the next call recovers)', async () => {
  mode = 'down';
  const text = `${URGENT} unique-d`;
  assert.equal(await i18n.localizeUrgent('ko', text, { deadlineMs: 500 }), text);
  mode = 'good';
  assert.match(await i18n.localizeUrgent('ko', text, { deadlineMs: 500 }), /^긴급/);
});

test('localizeUrgent: native languages and text without a model are untouched', async () => {
  assert.equal(await i18n.localizeUrgent('es', URGENT), URGENT);
  assert.equal(await i18n.localizeUrgent('en', URGENT), URGENT);
  assert.equal(await i18n.localizeUrgent('ko', ''), '');
});

test('the 911 reply to a non-native patient is never slower than the deadline and always says 911', async () => {
  mode = 'hang';
  store.updatePatient('p3', { language: 'ko' }); // no generated templates for ko
  const started = Date.now();
  const replies = await agent.handleInbound({ patientId: 'p3', text: 'I have chest pain' });
  assert.ok(Date.now() - started < 6000, `took ${Date.now() - started} ms`);
  assert.equal(replies[0].urgent, true);
  assert.match(replies[0].text, /911/);
});

test('record not found is a translatable string, not a hardcoded sentence in agent.js', async () => {
  const [r] = await agent.handleInbound({ patientId: 'nope', text: 'hi' });
  assert.equal(r.text, i18n.t('en', 'record_not_found'));
  assert.ok(i18n.t('es', 'record_not_found') !== i18n.t('en', 'record_not_found'));
});

test('the caregiver alert is written in the caregiver language (es) with a plain-language reason', async () => {
  const cg = store.getPatient('p1').caregiver;
  store.updatePatient('p1', { caregiver: { ...cg, language: 'es' }, caregiverConsent: true });
  await agent.handleInbound({ patientId: 'p1', text: 'tengo dolor de pecho' });
  const msgs = store.listMessages('p1').filter((m) => m.to === 'caregiver' && m.direction === 'out');
  assert.ok(msgs.length >= 1, 'caregiver was told');
  const first = msgs[0].text;
  assert.match(first, /Alerta de HeartBridge/);
  assert.match(first, /911/);
  assert.match(msgs[0].textEn, /HeartBridge alert for Maria/);
});
