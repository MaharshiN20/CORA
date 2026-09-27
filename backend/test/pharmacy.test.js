// P1-4: refill-gap detection, barrier capture, escalation, pickup.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-rx-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, clock, jobs, agent, planning, pharmacy;
before(async () => {
  store = await import('../src/store.js');
  clock = await import('../src/core/clock.js');
  jobs = await import('../src/core/jobs.js');
  agent = await import('../src/core/agent.js');
  planning = await import('../src/core/planning.js');
  pharmacy = await import('../src/core/pharmacy.js');
});

// Start every test at 06:00 local demo time so results don't depend on when the suite runs.
beforeEach(async () => {
  jobs.stop();
  store.reset();
  const six = planning.occurrences(['06:00'], clock.now(), clock.now() + clock.DAY)[0].at;
  clock.advance(six - clock.now());
  await jobs.start({ intervalMs: 0 });
});

async function advanceTo(hhmm) {
  const next = planning.occurrences([hhmm], clock.now(), clock.now() + clock.DAY)[0].at;
  const by = next - clock.now() + 60_000;
  clock.advance(by);
  return jobs.afterAdvance(by);
}
const nudges = (id) => store.listMessages(id).filter((m) => m.textEn?.includes("hasn't been picked up"));
const tap = (id, data) => agent.handleInbound({ patientId: id, buttonData: data });
const rx = (id, med) => store.getPatient(id).prescriptions.find((r) => r.med === med);
const refillTasks = (id) => store.listAlerts().filter((a) => a.patientId === id && a.kind === 'refill');

test('10:00 check nudges Maria about her unfilled water pill, in Spanish, with barrier buttons', async () => {
  await advanceTo('10:00');
  const n = nudges('p1');
  assert.equal(n.length, 1);
  assert.match(n[0].text, /Furosemide/);
  assert.match(n[0].text, /recogido/);
  assert.deepEqual(n[0].buttons.flat().map((b) => b.data), ['rx:Furosemide:picked', 'rx:Furosemide:ride', 'rx:Furosemide:cost', 'rx:Furosemide:other']);
  // picked-up prescriptions are never nudged
  assert.equal(nudges('p2').length, 0);
});

test('48h grace: not nudged before it, nudged after', async () => {
  store.updatePatient('p4', {
    prescriptions: [{ med: 'Furosemide', expectedPickup: new Date(clock.now() - 30 * clock.HOUR).toISOString(), pickedUpAt: null }],
  });
  jobs.replan();
  await advanceTo('10:00'); // 34h overdue
  assert.equal(nudges('p4').length, 0);
  await advanceTo('10:00'); // 58h overdue
  assert.equal(nudges('p4').length, 1);
});

test('cost barrier -> help message, YELLOW refill task (diuretic), SDOH flag, no more nudges', async () => {
  await advanceTo('10:00');
  const r = await tap('p1', 'rx:Furosemide:cost');
  assert.match(r[0].textEn, /Extra Help/);
  assert.equal(rx('p1', 'Furosemide').barrier, 'cost');
  const task = refillTasks('p1')[0];
  assert.equal(task.tier, 'YELLOW');
  assert.match(task.title, /costs too much/);
  assert.ok(store.getPatient('p1').sdoh.flags.includes('medication_cost'));
  await advanceTo('10:00');
  assert.equal(nudges('p1').length, 1); // barrier known -> the nurse task owns it
});

test('ride barrier on a non-diuretic -> INFO task + transportation flag', async () => {
  store.updatePatient('p4', {
    prescriptions: [{ med: 'Carvedilol', expectedPickup: new Date(clock.now() - 3 * clock.DAY).toISOString(), pickedUpAt: null }],
  });
  jobs.replan();
  await advanceTo('10:00');
  await tap('p4', 'rx:Carvedilol:ride');
  assert.equal(refillTasks('p4')[0].tier, 'INFO');
  assert.ok(store.getPatient('p4').sdoh.flags.includes('transportation'));
});

test('"picked up" button records pickup, resolves the task, stops nudges', async () => {
  await advanceTo('10:00');
  await tap('p1', 'rx:Furosemide:other');
  assert.equal(refillTasks('p1')[0].status, 'open');
  const r = await tap('p1', 'rx:Furosemide:picked');
  assert.match(r[0].textEn, /thank you/i);
  assert.ok(rx('p1', 'Furosemide').pickedUpAt);
  assert.equal(refillTasks('p1')[0].status, 'resolved');
  assert.equal(pharmacy.overdue(store.getPatient('p1')).length, 0);
});

test('no answer: nudged day 1 and day 2, then handed to a nurse on day 3 (once)', async () => {
  for (let d = 0; d < 4; d++) await advanceTo('10:00');
  assert.equal(nudges('p1').length, 2);
  const tasks = refillTasks('p1');
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].title, /no reply/);
});

test('3-day jump sends one nudge, not three', async () => {
  clock.advance(3 * clock.DAY);
  await jobs.afterAdvance(3 * clock.DAY);
  assert.equal(nudges('p1').length, 1);
});

test('dashboard endpoint marks a prescription picked up', async () => {
  const { createApp } = await import('../src/app.js');
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/api/patients/p1/prescriptions/furosemide/picked-up`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).pickedUpAt);
    assert.equal((await fetch(`${base}/api/patients/p1/prescriptions/aspirin/picked-up`, { method: 'POST' })).status, 404);
    assert.equal(store.listAudit('p1').at(-1).data.by, 'dashboard');
  } finally {
    server.close();
  }
});
