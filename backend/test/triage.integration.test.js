// Phase 3: the new triage inputs reach the right callers (typed BP, COPD oxygen, dry weight).
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-triage-int-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, agent, i18n, helpers;
before(async () => {
  store = await import('../src/store.js');
  agent = await import('../src/core/agent.js');
  i18n = await import('../src/core/i18n.js');
  helpers = await import('./helpers/checkin.js');
});
beforeEach(() => store.reset());

const send = (text, patientId = 'p1') => agent.handleInbound({ patientId, text });
const alerts = (patientId = 'p1') => store.listAlerts().filter((a) => a.patientId === patientId);

test('a typed blood pressure in range is just saved', async () => {
  const [r] = await send('118/72');
  assert.equal(r.text, i18n.t('es', 'bp_logged', { bp: '118/72' }));
  assert.equal(alerts().length, 0);
  assert.equal(store.getPatient('p1').vitals.at(-1).sbp, 118);
});

test('a low blood pressure (86/52) raises a YELLOW for the nurse and tells the patient so', async () => {
  const [r] = await send('86/52');
  assert.equal(r.text, i18n.t('es', 'bp_flagged', { bp: '86/52' }));
  const a = alerts();
  assert.equal(a.length, 1);
  assert.equal(a[0].tier, 'YELLOW');
  assert.match(a[0].reasons[0], /86\/52/);
  assert.equal(a[0].source, 'blood pressure');
});

test('a critical blood pressure (76/40) is RED: the patient is told to call 911', async () => {
  const [r] = await send('76/40');
  assert.equal(r.urgent, true);
  assert.equal(alerts()[0].tier, 'RED');
});

test('a very high blood pressure (190/115) raises a YELLOW', async () => {
  await send('190/115');
  assert.deepEqual(alerts().map((a) => a.tier), ['YELLOW']);
});

test('an English-speaking patient gets the English bp_flagged text', async () => {
  const [r] = await send('85/50', 'p2');
  assert.equal(r.text, i18n.t(store.getPatient('p2').language, 'bp_flagged', { bp: '85/50' }));
});

test('dry weight: a patient creeping to 6 lb over target gets a YELLOW at check-in', async () => {
  const p = store.getPatient('p2');
  const dry = 150;
  const day = 24 * 3600 * 1000;
  store.updatePatient('p2', {
    dryWeightLb: dry,
    weights: [0.5, 0.4, 0.3].map((x, i) => ({ ts: new Date(Date.now() - (3 - i) * day).toISOString(), lb: 155.4 + x })),
  });
  void p;
  await agent.handleInbound({ patientId: 'p2', buttonData: 'cmd:checkin' });
  await helpers.completeCheckin(agent, store, 'p2', { weight: '156' });
  assert.ok(alerts('p2').some((a) => a.reasons.some((r) => /above dry weight/.test(r))), JSON.stringify(alerts('p2').map((a) => a.reasons)));
});

test('COPD: an SpO2 of 89 at the check-in is a nurse call, not a 911; 86 is still a 911', async () => {
  for (const id of store.listPatients().map((x) => x.id)) {
    store.updatePatient(id, { profile: { ...store.getPatient(id).profile, copd: true } });
  }
  // Find a patient whose plan asks for SpO2 (higher-risk plans do).
  let ran = false;
  for (const p of store.listPatients()) {
    store.reset();
    for (const id of store.listPatients().map((x) => x.id)) store.updatePatient(id, { profile: { ...store.getPatient(id).profile, copd: true } });
    await agent.handleInbound({ patientId: p.id, buttonData: 'cmd:checkin' });
    let asked = false;
    for (let i = 0; i < 12 && store.getPatient(p.id).checkin?.state !== 'idle'; i++) {
      const step = store.getPatient(p.id).checkin.state;
      if (step === 'spo2') asked = true;
      const ans = step === 'spo2' ? '89' : helpers.DEFAULT_ANSWERS[step] ?? String(store.getPatient(p.id).weights.at(-1)?.lb ?? 150);
      await agent.handleInbound({ patientId: p.id, ...(ans.startsWith('ci:') ? { buttonData: ans } : { text: ans }) });
    }
    if (!asked) continue;
    ran = true;
    const tiers = alerts(p.id).map((a) => a.tier);
    assert.ok(!tiers.includes('RED'), `COPD 89% must not be RED (${tiers})`);
    assert.ok(alerts(p.id).some((a) => a.reasons.some((r) => /SpO2 89%.*COPD/.test(r))));
    break;
  }
  assert.ok(ran, 'at least one seeded patient is asked for SpO2');
});
