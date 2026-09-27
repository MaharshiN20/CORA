// The core follows Maharshi's Risk v2: live tier drives the plan and is saved after each check-in.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { completeCheckin } from './helpers/checkin.js';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-risklive-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, agent, signals, risk;
before(async () => {
  store = await import('../src/store.js');
  agent = await import('../src/core/agent.js');
  signals = await import('../src/core/signals.js');
  risk = await import('../src/core/risk.js');
});
beforeEach(() => store.reset());

test('seed patients start from a realistic history (no fake missed check-ins)', () => {
  for (const id of ['p1', 'p2', 'p4']) assert.equal(signals.getSignals(store.getPatient(id)).missedCheckins7d, 0, id);
  assert.ok(store.getPatient('p1').checkins.length >= 5);
  assert.ok(store.getPatient('p1').checkins.every((c) => c.seeded));
  // stable patients stay Low under the live score
  for (const id of ['p3', 'p5']) {
    const p = store.getPatient(id);
    assert.equal(risk.scoreRisk(p, signals.getSignals(p)).tier, 'Low', id);
  }
});

test('a finished check-in saves the live risk (baseline + dynamic + trend) on the patient', async () => {
  await agent.startCheckin('p5');
  await completeCheckin(agent, store, 'p5', { weight: '140' });
  const p = store.getPatient('p5');
  const expected = risk.scoreRisk(p, signals.getSignals(p));
  assert.equal(p.riskTier, expected.tier);
  assert.equal(p.riskScore, expected.score);
  assert.ok(p.riskBaseline && Array.isArray(p.riskBaseline.factors));
  assert.ok(p.riskDynamic && ['up', 'down', 'flat'].includes(p.riskDynamic.trend));
});

test('bad signals raise the live tier and deepen tomorrow\'s check-in', async () => {
  // Dorothy (baseline Low) with two missed water pills and an open RED alert
  const dosesDays = [2, 1].map((d) => ({ id: `x${d}`, ts: new Date(Date.now() - d * 86400000).toISOString(), med: 'Furosemide', diuretic: true, taken: false }));
  store.updatePatient('p5', { doses: dosesDays });
  store.addAlert({ patientId: 'p5', tier: 'RED', reasons: ['Chest pain'] });
  const p = store.getPatient('p5');
  const live = risk.scoreRisk(p, signals.getSignals(p));
  assert.notEqual(live.tier, 'Low');
  const r = await agent.startCheckin('p5');
  assert.match(r[1].text, /weight/i);
  await agent.handleInbound({ patientId: 'p5', text: '140' });
  await agent.handleInbound({ patientId: 'p5', buttonData: 'ci:breath:normal' });
  assert.equal(store.getPatient('p5').checkin.state, 'orthopnea'); // Med/High plans ask about pillows; Low didn't
});
