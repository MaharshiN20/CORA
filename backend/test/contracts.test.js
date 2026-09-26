// Cross-lane contracts (docs/CONTRACTS.md). If one of these breaks, another lane breaks.
// Change a contract only via docs/team/REQUESTS.md, then update this file.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-contracts-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;
process.env.TELEGRAM_BOT_USERNAME = 'heartbridge_test_bot';

let store, clock, enroll, signals, agent, server, base;

before(async () => {
  store = await import('../src/store.js');
  clock = await import('../src/core/clock.js');
  enroll = await import('../src/core/enroll.js');
  signals = await import('../src/core/signals.js');
  agent = await import('../src/core/agent.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());
beforeEach(() => store.reset());

const get = async (p) => (await fetch(base + p)).json();
const send = async (method, p, body) =>
  fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// ---------- clock ----------
test('clock: advance moves now() and persists across reset boundaries', () => {
  const t0 = clock.now();
  clock.advance(2 * clock.HOUR);
  assert.ok(clock.now() - t0 >= 2 * clock.HOUR);
  store.reset();
  assert.equal(clock.offset(), 0);
});

// ---------- store ----------
test('store: alert lifecycle keeps history, SLA and outcome', () => {
  const a = store.addAlert({ patientId: 'p1', tier: 'RED', reasons: ['Chest pain'] });
  assert.equal(a.status, 'open');
  assert.equal(a.kind, 'triage');
  assert.equal(Date.parse(a.dueBy) - Date.parse(a.ts), 15 * 60 * 1000);
  store.updateAlert(a.id, { status: 'acknowledged', by: 'Nurse Kim' });
  const done = store.updateAlert(a.id, { status: 'resolved', outcome: 'ed_avoided' });
  assert.deepEqual(done.history.map((h) => h.status), ['open', 'acknowledged', 'resolved']);
  assert.equal(done.history[1].by, 'Nurse Kim');
  assert.equal(done.outcome, 'ed_avoided');
});

test('store: tasks, audit, readings, generic collections', () => {
  const t = store.addTask({ patientId: 'p1', kind: 'refill', title: 'Furosemide not picked up' });
  assert.equal(t.tier, 'INFO');
  store.audit('triage', 'p1', { tier: 'YELLOW' });
  assert.equal(store.listAudit('p1').at(-1).data.tier, 'YELLOW');
  store.addReading({ patientId: 'p1', type: 'spo2', value: 91, source: 'device' });
  assert.equal(store.listReadings('p1', 'spo2')[0].value, 91);
  store.collection('cohort').push({ id: 'c1' });
  store.persist();
  assert.equal(store.collection('cohort').length, 1);
});

// ---------- enroll ----------
test('enroll: languages list has native en/es', () => {
  const langs = enroll.languages();
  assert.ok(langs.find((l) => l.code === 'es').native);
  assert.equal(langs.find((l) => l.code === 'vi').native, false);
});

test('enroll: demo patient clones the hero story with a fresh identity', async () => {
  const p = enroll.enrollDemoPatient({ chatId: 999, language: 'es' });
  assert.match(p.linkCode, /^DEMO[A-Z0-9]{5}$/);
  assert.equal(p.chatId, 999);
  assert.equal(p.language, 'es');
  assert.equal(p.riskTier, 'High');
  assert.equal(store.findByChatId(999).patient.id, p.id);
  // first check-in reply is in the chosen language
  const r = await agent.startCheckin(p.id);
  assert.match(r[0].text, /Buenos días/);
});

test('enroll: createPatient fills defaults and validates', () => {
  const p = enroll.createPatient({ name: 'Ada Lovelace', age: 81, language: 'xx' });
  assert.equal(p.language, 'en');
  assert.ok(p.linkCode);
  assert.ok(['Low', 'Med', 'High'].includes(p.riskTier));
  assert.throws(() => enroll.createPatient({}), /name is required/);
});

// ---------- signals ----------
test('signals: stable shape with nulls for missing data', () => {
  const s = signals.getSignals(store.getPatient('p1'));
  for (const k of ['daysSinceDischarge', 'missedCheckins7d', 'adherence7d', 'weightDelta24h', 'weightDelta7d', 'openAlerts', 'sdohFlags', 'lessonScore', 'rpmDays30']) {
    assert.ok(k in s, `missing ${k}`);
  }
  assert.equal(s.adherence7d, null);
  assert.equal(s.weightDelta24h, 2.7);
  assert.ok(s.rpmDays30 >= 6);
});

// ---------- agent contract ----------
test('agent: caregiver role and photo are accepted', async () => {
  const cg = await agent.handleInbound({ patientId: 'p1', role: 'caregiver', text: 'hi', channel: 'telegram' });
  assert.match(cg[0].text, /caregiver/);
  const ph = await agent.handleInbound({ patientId: 'p1', photo: { base64: 'aGVsbG8=', mime: 'image/jpeg' } });
  assert.match(ph[0].text, /foto/); // Maria is Spanish
  assert.equal(store.listAudit('p1').at(-1).type, 'photo_received');
});

test('agent: RED replies are flagged urgent; voiceMode sets voice', async () => {
  store.updatePatient('p5', { voiceMode: true });
  const r = await agent.handleInbound({ patientId: 'p5', text: 'chest pain right now' });
  assert.equal(r[0].urgent, true);
  assert.equal(r[0].voice, true);
});

// ---------- HTTP routes every lane depends on ----------
test('http: health, languages, patients with signals, join links', async () => {
  const h = await get('/api/health');
  assert.equal(h.ok, true);
  assert.equal(h.llm.provider, 'none');
  assert.ok((await get('/api/languages')).length >= 10);
  const patients = await get('/api/patients');
  assert.ok(patients[0].signals);
  const detail = await get('/api/patients/p1');
  for (const k of ['messages', 'alerts', 'readings', 'audit', 'signals']) assert.ok(k in detail, `missing ${k}`);
  const j = await get('/api/join');
  assert.equal(j.links.find((l) => l.language === 'es').url, 'https://t.me/heartbridge_test_bot?start=DEMO_ES');
});

test('http: alert PATCH validates and audits', async () => {
  const a = store.addAlert({ patientId: 'p2', tier: 'YELLOW', reasons: ['Weight up'] });
  assert.equal((await send('PATCH', `/api/alerts/${a.id}`, { status: 'bogus' })).status, 400);
  const ok = await (await send('PATCH', `/api/alerts/${a.id}`, { status: 'contacted', by: 'RN' })).json();
  assert.equal(ok.status, 'contacted');
  assert.equal(store.listAudit('p2').at(-1).type, 'nurse_action');
});

test('http: demo clock advance + create patient', async () => {
  const r = await (await send('POST', '/api/demo/advance', { hours: 48 })).json();
  assert.equal(r.offsetMs, 48 * clock.HOUR);
  assert.equal((await send('POST', '/api/demo/advance', { hours: -1 })).status, 400);
  const created = await send('POST', '/api/patients', { name: 'Test Person' });
  assert.equal(created.status, 201);
  assert.equal((await send('POST', '/api/patients', {})).status, 400);
});

test('http: device readings validate and store', async () => {
  const ok = await send('POST', '/api/devices/readings', { patientId: 'p1', type: 'spo2', value: 92, device: 'virtual-oximeter' });
  assert.equal(ok.status, 201);
  assert.equal(store.listReadings('p1', 'spo2')[0].source, 'device');
  assert.equal((await send('POST', '/api/devices/readings', { patientId: 'p1', type: 'spo2', value: 150 })).status, 400);
  assert.equal((await send('POST', '/api/devices/readings', { patientId: 'nope', type: 'hr', value: 70 })).status, 404);
  assert.deepEqual(await get('/api/demo/scenarios'), []);
});

test('http: lane stubs are mounted', async () => {
  for (const p of ['/api/insights', '/api/fhir', '/webhooks']) assert.equal((await fetch(base + p)).status, 200, p);
});
