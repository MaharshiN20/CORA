// Bugs found by the independent bug hunt (docs/independent-eval/REPORT.md) that live in another
// lane's files, so they are logged in docs/team/REQUESTS.md instead of fixed here. Each test below
// FAILS today and is marked `todo`: it runs on every `npm test` and shows up in the summary, without
// turning the suite red. Whoever fixes one removes its `todo` line; the test then guards the fix.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-independent-open-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.API_TOKEN;

let store, agent, server, base;

before(async () => {
  store = await import('../src/store.js');
  agent = await import('../src/core/agent.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());
beforeEach(() => store.reset());

const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const OPEN = 'open bug in another lane, see docs/team/REQUESTS.md (independent bug hunt)';

// core/enroll.js: one malformed POST takes the worklist down for every nurse.
test('POST /api/patients refuses weights / prescriptions / meds that are not lists', { todo: OPEN }, async () => {
  for (const field of ['weights', 'prescriptions', 'meds']) {
    for (const bad of ['', true, { length: 3 }]) {
      const made = await call('POST', '/api/patients', { name: 'Bad Shape', [field]: bad });
      const list = await call('GET', '/api/patients');
      const impact = await call('GET', '/api/insights/impact');
      store.reset(); // do not let one poisoned record fail the next case for the wrong reason
      assert.equal(made.status, 400, `${field}=${JSON.stringify(bad)} was accepted`);
      assert.equal(list.status, 200, `GET /api/patients after ${field}=${JSON.stringify(bad)}`);
      assert.equal(impact.status, 200, `GET /api/insights/impact after ${field}=${JSON.stringify(bad)}`);
    }
  }
});

// routes/api.js: the dashboard's "start check-in" and "social-needs screen" ignore the RED lock.
test('nothing but "call 911" reaches a patient during the RED lock, even when a nurse presses "start check-in"', { todo: OPEN }, async () => {
  await agent.handleInbound({ patientId: 'p1', channel: 'sim', text: 'me duele mucho el pecho' });
  const out = () => store.listMessages('p1').filter((m) => m.direction === 'out' && m.to === 'patient').length;
  const before = out();
  const checkin = await call('POST', '/api/patients/p1/checkin', {});
  const sdoh = await call('POST', '/api/patients/p1/sdoh/start', {});
  assert.equal(out(), before, 'no question was sent to someone who was just told to call 911');
  assert.equal(store.getPatient('p1').checkin?.state ?? 'idle', 'idle');
  assert.ok(checkin.status === 409 && sdoh.status === 409, `expected 409 twice, got ${checkin.status} and ${sdoh.status}`);
});

// core/agent.js handleCaregiver: CONTRACTS.md says an old "chest pain" tap is still an emergency.
test('a caregiver tapping "chest pain" on an old check-in message raises a RED alert, like the patient\'s tap does', { todo: OPEN }, async () => {
  const replies = await agent.handleInbound({ patientId: 'p1', role: 'caregiver', channel: 'sim', buttonData: 'ci:rf:chest' });
  assert.equal(store.listAlerts('p1').filter((a) => a.tier === 'RED').length, 1);
  assert.ok(replies[0].urgent);
});

// core/checkin.js finish(): "your family" is promised (in English, inside any language) with no caregiver on file.
test('the 911 message does not say the family was alerted when the patient has no caregiver', { todo: OPEN }, async () => {
  const made = await call('POST', '/api/patients', { name: 'Ann Alone', language: 'en' });
  const id = made.json.id;
  await agent.handleInbound({ patientId: id, channel: 'sim', buttonData: 'cmd:checkin' });
  const [reply] = await agent.handleInbound({ patientId: id, channel: 'sim', buttonData: 'ci:rf:chest' });
  assert.ok(reply.urgent);
  assert.doesNotMatch(reply.text, /your family/i, reply.text);
});

// core/devicetriage.js: a numeric ts no Date can hold throws instead of answering 400.
test('POST /api/devices/readings answers 400 for a timestamp no calendar can hold', { todo: OPEN }, async () => {
  const res = await call('POST', '/api/devices/readings', { patientId: 'p1', type: 'weight', value: 170, ts: 1e308 });
  assert.equal(res.status, 400);
});

// store.js: writes are held back 250 ms, so a crash right after "call 911" loses the RED alert,
// the lock and the conversation (docs/independent-eval/edge.mjs shows it with a real kill -9).
test('a RED alert is on disk before the patient is answered (a crash in the next 250 ms must not lose it)', { todo: OPEN }, async () => {
  await agent.handleInbound({ patientId: 'p1', channel: 'sim', text: 'me duele mucho el pecho' });
  const onDisk = fs.existsSync(process.env.HEARTBRIDGE_DB) ? JSON.parse(fs.readFileSync(process.env.HEARTBRIDGE_DB, 'utf8')) : { alerts: [] };
  assert.equal(onDisk.alerts.filter((a) => a.patientId === 'p1' && a.tier === 'RED').length, 1);
});
