// Standing order: one click applies once, bad input is a 400 not a 500, missing labs never pass.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-test-protocols-hard-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, scenarios, protocols, server, base;
before(async () => {
  store = await import('../src/store.js');
  scenarios = await import('../src/core/scenarios.js');
  protocols = await import('../src/core/protocols.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());
beforeEach(() => store.reset());

const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json() };
};
async function mariaYellow() {
  await scenarios.run('maria', { delayMs: 0, wait: true });
  return store.listAlerts().find((a) => a.patientId === 'p1' && a.kind === 'triage');
}
const check = (res, id) => res.checks.find((c) => c.id === id);

test('two clicks at once apply the order once: one message, one task, one success and one 409', async () => {
  const alert = await mariaYellow();
  const before = store.listMessages('p1').length;
  const tasksBefore = store.listAlerts().filter((a) => a.kind === 'protocol_followup').length;
  // Same tick: both reach the eligibility check before either has finished sending.
  const [a, b] = await Promise.allSettled([protocols.apply(alert.id, { by: 'Ana' }), protocols.apply(alert.id, { by: 'Ben' })]);
  assert.deepEqual([a.status, b.status].sort(), ['fulfilled', 'rejected']);
  assert.equal((a.reason ?? b.reason).status, 409);
  assert.equal(store.listAlerts().filter((x) => x.kind === 'protocol_followup').length, tasksBefore + 1);
  assert.equal(store.listMessages('p1').length, before + 1, 'the patient got the instructions once');
  assert.equal(store.listAudit('p1').filter((e) => e.type === 'protocol_applied').length, 1);
});

test('a refused apply does not leave the alert locked: fix the problem and apply again', async () => {
  const alert = await mariaYellow();
  const meds = store.getPatient('p1').meds;
  store.updatePatient('p1', { meds: [] });
  await assert.rejects(() => protocols.apply(alert.id, { by: 'Ana' }), (e) => e.status === 409);
  store.updatePatient('p1', { meds });
  assert.ok((await protocols.apply(alert.id, { by: 'Ana' })).task);
});

test('labs with a missing potassium or creatinine never pass', async () => {
  const alert = await mariaYellow();
  const labs = store.getPatient('p1').labs;
  for (const bad of [{ ...labs, potassium: undefined }, { ...labs, creatinine: null }, { ...labs, potassium: 'high' }, { at: labs.at }]) {
    store.updatePatient('p1', { labs: bad });
    const res = protocols.eligibility(store.getPatient('p1'), alert);
    assert.notEqual(check(res, 'labs').status, 'pass', JSON.stringify(bad));
    assert.equal(res.eligible, false);
  }
});

test('labs with an unparseable or future date never pass', async () => {
  const alert = await mariaYellow();
  const labs = store.getPatient('p1').labs;
  for (const at of ['not a date', new Date(Date.now() + 30 * 864e5).toISOString()]) {
    store.updatePatient('p1', { labs: { ...labs, at } });
    assert.notEqual(check(protocols.eligibility(store.getPatient('p1'), alert), 'labs').status, 'pass', at);
  }
});

test('an unknown protocolId is a 400, a non-string "by" is a 400, a missing alert is a 404', async () => {
  const alert = await mariaYellow();
  assert.equal((await post(`/api/alerts/${alert.id}/protocol`, { protocolId: 'NOPE' })).status, 400);
  assert.equal((await post(`/api/alerts/${alert.id}/protocol`, { by: { x: 1 } })).status, 400);
  assert.equal((await post(`/api/alerts/${alert.id}/protocol`, { by: 12 })).status, 400);
  assert.equal((await post('/api/alerts/does-not-exist/protocol', {})).status, 404);
  assert.equal(store.getAlert(alert.id).protocol, undefined, 'nothing was applied');
});

test('a blank "by" falls back to "Your nurse"', async () => {
  const alert = await mariaYellow();
  const res = await post(`/api/alerts/${alert.id}/protocol`, { by: '   ' });
  assert.equal(res.status, 200);
  assert.equal(res.body.alert.protocol.by, 'Your nurse');
});
