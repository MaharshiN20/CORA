// P1-6: nurse -> patient messaging, templates, and ack notices.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-nurse-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, nurse, llm, server, base;
const realFetch = globalThis.fetch;
before(async () => {
  store = await import('../src/store.js');
  nurse = await import('../src/core/nurse.js');
  llm = await import('../src/core/llm/index.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());
beforeEach(() => {
  globalThis.fetch = realFetch;
  process.env.LLM_PROVIDER = 'none';
  llm._reset();
  store.reset();
});

const send = (method, p, body) =>
  realFetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const lastToPatient = (id) => store.listMessages(id).filter((m) => m.direction === 'out' && m.to === 'patient').at(-1);

test('free-text message to an English patient: signed, delivered via channel log, audited', async () => {
  const r = await send('POST', '/api/patients/p5/message', { text: 'Please weigh yourself again this evening.', from: 'Nurse Kim' });
  assert.equal(r.status, 200);
  const msg = lastToPatient('p5');
  assert.match(msg.text, /Nurse Kim \(your care team\): Please weigh yourself again/);
  const a = store.listAudit('p5').at(-1);
  assert.equal(a.type, 'nurse_message');
  assert.equal(a.data.from, 'Nurse Kim');
});

test('Spanish patient, no LLM: Spanish wrapper, English body kept (never silently dropped)', async () => {
  await nurse.sendNurseMessage('p1', { text: 'Call us if you feel worse.', from: 'Nurse Kim' });
  const msg = lastToPatient('p1');
  assert.match(msg.text, /Nurse Kim \(su equipo médico\): Call us if you feel worse\./);
  assert.match(msg.textEn, /your care team\): Call us/);
});

test('Spanish patient with an LLM: body translated, English original kept for the nurse', async () => {
  process.env.LLM_PROVIDER = 'lmstudio';
  globalThis.fetch = async (url, opts) => {
    if (String(url).endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }] }));
    if (String(url).endsWith('/v1/chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Llámenos si se siente peor.' } }] }));
    }
    return realFetch(url, opts);
  };
  const r = await nurse.sendNurseMessage('p1', { text: 'Call us if you feel worse.', from: 'Nurse Kim' });
  assert.match(r.text, /Nurse Kim \(su equipo médico\): Llámenos si se siente peor\./);
  assert.match(r.textEn, /Call us if you feel worse/);
  assert.equal(store.listAudit('p1').at(-1).data.translated, true);
});

test('call_scheduled template uses native Spanish', async () => {
  const r = await (await send('POST', '/api/patients/p1/message', { template: 'call_scheduled', time: '2:30 PM', from: 'Nurse Kim' })).json();
  assert.match(r.text, /Nurse Kim de su equipo médico le llamará a las 2:30 PM/);
  assert.match(r.textEn, /will call you at 2:30 PM/);
});

test('validation: empty text, unknown template, missing time, unknown patient', async () => {
  assert.equal((await send('POST', '/api/patients/p1/message', {})).status, 400);
  assert.equal((await send('POST', '/api/patients/p1/message', { text: '   ' })).status, 400);
  assert.equal((await send('POST', '/api/patients/p1/message', { template: 'bogus' })).status, 400);
  assert.equal((await send('POST', '/api/patients/p1/message', { template: 'call_scheduled' })).status, 400);
  assert.equal((await send('POST', '/api/patients/nope/message', { text: 'hi' })).status, 404);
});

test('acknowledging a triage alert tells the patient once', async () => {
  const a = store.addAlert({ patientId: 'p1', tier: 'YELLOW', reasons: ['Weight up 2.7 lb in 24h'] });
  const r = await (await send('PATCH', `/api/alerts/${a.id}`, { status: 'acknowledged', by: 'Nurse Kim' })).json();
  assert.ok(r.patientNotifiedAt);
  assert.match(lastToPatient('p1').text, /Nurse Kim de su equipo médico vio su mensaje/);
  await send('PATCH', `/api/alerts/${a.id}`, { status: 'contacted', by: 'Nurse Kim' });
  await send('PATCH', `/api/alerts/${a.id}`, { status: 'acknowledged', by: 'Nurse Kim' });
  const notices = store.listMessages('p1').filter((m) => /vio su mensaje/.test(m.text));
  assert.equal(notices.length, 1);
});

test('INFO tasks (refill/SDOH) do not send an ack notice', async () => {
  const t = store.addTask({ patientId: 'p5', kind: 'refill', title: 'Furosemide not picked up' });
  const before = store.listMessages('p5').length;
  await send('PATCH', `/api/alerts/${t.id}`, { status: 'acknowledged', by: 'Nurse Kim' });
  assert.equal(store.listMessages('p5').length, before);
});
