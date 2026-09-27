// Scripted demo scenarios (P4-15): listing, pacing, replay and errors. The happy paths
// (outcomes per scenario) run over HTTP in tools/e2e-demo.js.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-test-scenarios-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, scenarios;
before(async () => {
  store = await import('../src/store.js');
  scenarios = await import('../src/core/scenarios.js');
});
beforeEach(() => store.reset());

test('list: every scenario names its patient, tier and step count', () => {
  const list = scenarios.list();
  assert.deepEqual(list.map((s) => s.name), ['dorothy', 'maria', 'thanh', 'anil']);
  for (const s of list) {
    assert.ok(store.getPatient(s.patientId), s.name);
    assert.ok(s.title && s.description && s.steps > 0, s.name);
    assert.ok(['GREEN', 'YELLOW', 'RED', 'SILENT'].includes(s.tier), s.name);
  }
});

test('unknown scenario -> 404', async () => {
  await assert.rejects(scenarios.run('nope'), (e) => e.status === 404);
});

test('runs in the background at a human pace; a second run for the same patient -> 409', async () => {
  const started = await scenarios.run('dorothy', { delayMs: 30 });
  assert.equal(started.patientId, 'p5');
  assert.equal(store.getPatient('p5').lastTier, 'GREEN'); // seeded tier, nothing played yet
  await assert.rejects(scenarios.run('dorothy', { delayMs: 0 }), (e) => e.status === 409);
  const finished = () => store.listAudit('p5').some((e) => e.type === 'scenario' && e.data.event === 'finished');
  for (let i = 0; i < 100 && !finished(); i++) await new Promise((r) => setTimeout(r, 50));
  const p = store.getPatient('p5');
  assert.equal(p.checkin.state, 'idle');
  assert.ok(store.listAudit('p5').some((e) => e.type === 'scenario' && e.data.event === 'finished'));
});

test('a replay starts from the seed: earlier alerts and messages for that patient are gone', async () => {
  await scenarios.run('thanh', { delayMs: 0, wait: true });
  assert.equal(store.listAlerts().filter((a) => a.patientId === 'p3').length, 1);
  await scenarios.run('thanh', { delayMs: 0, wait: true });
  assert.equal(store.listAlerts().filter((a) => a.patientId === 'p3').length, 1);
  assert.equal(store.listMessages('p3').filter((m) => m.direction === 'in').length, 2);
});

test('resetPatient keeps chat links and leaves other patients alone', () => {
  store.updatePatient('p1', { chatId: 42, caregiver: { ...store.getPatient('p1').caregiver, chatId: 43 } });
  store.addAlert({ patientId: 'p2', tier: 'YELLOW', reasons: ['x'] });
  store.resetPatient('p1');
  assert.equal(store.getPatient('p1').chatId, 42);
  assert.equal(store.getPatient('p1').caregiver.chatId, 43);
  assert.equal(store.listAlerts().filter((a) => a.patientId === 'p2').length, 1);
});
