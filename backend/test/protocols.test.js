// Standing diuretic order (HF-02): eligibility from the clinic's protocol file, server-side
// re-check, and every side effect of the one click. No network, no LLM.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-test-protocols-${process.pid}.json`);
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

const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
// Maria's scenario: YELLOW for weight + swelling, took her diuretic, labs in range, no BP.
async function mariaYellow() {
  await scenarios.run('maria', { delayMs: 0, wait: true });
  return store.listAlerts().find((a) => a.patientId === 'p1' && a.kind === 'triage');
}
const check = (res, id) => res.checks.find((c) => c.id === id);

test('the protocol file is marked as a demo and names its author', () => {
  const p = protocols.PROTOCOLS['HF-02'];
  assert.equal(p.demo, true);
  assert.match(p.disclaimer, /Not medical advice/);
  assert.ok(p.authoredBy && p.patientInstructions.en && p.patientInstructions.es);
});

test('Maria (fluid gain, no red flags, took her pill, labs ok) is eligible; BP unknown is optional', async () => {
  const alert = await mariaYellow();
  const res = protocols.eligibility(store.getPatient('p1'), alert);
  assert.equal(res.triggered, true);
  assert.equal(res.eligible, true);
  assert.equal(check(res, 'no_red_flags').status, 'pass');
  assert.equal(check(res, 'diuretic_taken').status, 'pass');
  assert.equal(check(res, 'labs').status, 'pass');
  assert.equal(check(res, 'bp').status, 'unknown');
  assert.equal(check(res, 'bp').action, 'ask_bp');
});

test('GET /alerts carries the protocol check on the triggering alert only', async () => {
  await mariaYellow();
  store.addTask({ patientId: 'p1', kind: 'refill', tier: 'INFO', title: 'x' });
  const { body } = await call('GET', '/api/alerts');
  const triage = body.find((a) => a.patientId === 'p1' && a.kind === 'triage');
  assert.equal(triage.protocolCheck.protocol.id, 'HF-02');
  assert.ok(body.filter((a) => a.kind !== 'triage').every((a) => !a.protocolCheck));
});

test('labs out of range, a missed pill, or a low BP make it ineligible', async () => {
  const alert = await mariaYellow();
  const p = store.getPatient('p1');
  store.updatePatient('p1', { labs: { ...p.labs, potassium: 5.6 } });
  let res = protocols.eligibility(store.getPatient('p1'), alert);
  assert.equal(check(res, 'labs').status, 'fail');
  assert.equal(res.eligible, false);

  store.updatePatient('p1', { labs: p.labs, vitals: [{ ts: new Date().toISOString(), sbp: 88, dbp: 50 }] });
  res = protocols.eligibility(store.getPatient('p1'), alert);
  assert.equal(check(res, 'bp').status, 'fail');
  assert.equal(res.eligible, false);

  store.updatePatient('p1', { vitals: [] });
  const checkins = store.getPatient('p1').checkins;
  checkins.at(-1).answers.diureticTaken = false;
  res = protocols.eligibility(store.getPatient('p1'), alert);
  assert.equal(check(res, 'diuretic_taken').status, 'fail');
});

test('a red flag or an open RED alert excludes the patient', async () => {
  const alert = await mariaYellow();
  store.addAlert({ patientId: 'p1', tier: 'RED', reasons: ['Chest pain'] });
  const res = protocols.eligibility(store.getPatient('p1'), alert);
  assert.equal(check(res, 'no_red_flags').status, 'fail');
  assert.equal(res.eligible, false);
});

test('not triggered for a YELLOW without fluid signs, or from the AI reviewer', () => {
  const p = store.getPatient('p5');
  store.updatePatient('p5', { checkins: [...p.checkins, { ts: new Date().toISOString(), answers: {}, tier: 'YELLOW', flags: [{ code: 'missed_diuretic', tier: 'YELLOW', text: 'Missed diuretic 2 days' }] }] });
  const a = store.addAlert({ patientId: 'p5', tier: 'YELLOW', reasons: ['Missed'] });
  assert.equal(protocols.eligibility(store.getPatient('p5'), a).triggered, false);
  const ai = store.addAlert({ patientId: 'p5', tier: 'YELLOW', reasons: ['x'], source: 'ai_review' });
  assert.equal(protocols.eligibility(store.getPatient('p5'), ai).triggered, false);
});

test('apply: Spanish instructions from the file, alert contacted, re-weigh task at 08:00, audit, FHIR preview', async () => {
  const alert = await mariaYellow();
  const { status, body } = await call('POST', `/api/alerts/${alert.id}/protocol`, { by: 'Nurse Kim' });
  assert.equal(status, 200);
  assert.match(body.message.text, /Nurse Kim de su equipo médico/);
  assert.match(body.message.text, /UNA dosis extra de su pastilla para el agua \(Furosemide 40 mg\)/);
  assert.match(body.message.textEn, /ONE extra dose of your water pill \(Furosemide 40 mg\)/);
  assert.equal(body.alert.status, 'contacted');
  assert.equal(body.alert.protocol.id, 'HF-02');
  assert.equal(body.task.kind, 'protocol_followup');
  assert.equal(new Date(body.task.dueBy).getHours(), 8);
  assert.equal(body.fhir.medicationRequest.resourceType, 'MedicationRequest');
  assert.equal(body.fhir.medicationRequest.status, 'draft');
  assert.match(body.fhir.medicationRequest.note[0].text, /HF-02.*DEMO/);
  assert.equal(body.fhir.communicationRequest.resourceType, 'CommunicationRequest');
  const audit = store.listAudit('p1').find((e) => e.type === 'protocol_applied');
  assert.equal(audit.data.by, 'Nurse Kim');
  assert.ok(audit.data.checks.length >= 4);
  const out = store.listMessages('p1').filter((m) => m.direction === 'out' && m.to === 'patient').at(-1);
  assert.match(out.text, /pastilla para el agua/);
});

test('apply twice or when ineligible -> 409 with the failing checks', async () => {
  const alert = await mariaYellow();
  assert.equal((await call('POST', `/api/alerts/${alert.id}/protocol`, {})).status, 200);
  const again = await call('POST', `/api/alerts/${alert.id}/protocol`, {});
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already applied/);

  store.reset();
  const a2 = await mariaYellow();
  store.updatePatient('p1', { labs: null });
  const blocked = await call('POST', `/api/alerts/${a2.id}/protocol`, {});
  assert.equal(blocked.status, 409);
  assert.ok(blocked.body.checks.some((c) => c.id === 'labs' && c.status === 'unknown'));
  assert.equal((await call('POST', '/api/alerts/nope/protocol', {})).status, 404);
});

test('ask_bp template and a typed "118/72" closes the loop', async () => {
  const alert = await mariaYellow();
  const r = await call('POST', '/api/patients/p1/message', { template: 'ask_bp', from: 'Nurse Kim' });
  assert.equal(r.status, 200);
  assert.match(r.body.text, /presión arterial/);
  const agent = await import('../src/core/agent.js');
  const reply = await agent.handleInbound({ patientId: 'p1', text: '118/72' });
  assert.match(reply[0].text, /118\/72/);
  const res = protocols.eligibility(store.getPatient('p1'), alert);
  assert.equal(check(res, 'bp').status, 'pass');
});
