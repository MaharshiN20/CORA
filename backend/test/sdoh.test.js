// P2-10: social-needs screen.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-sdoh-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, clock, jobs, scheduler, agent, planning, signals, sdoh;
before(async () => {
  store = await import('../src/store.js');
  clock = await import('../src/core/clock.js');
  jobs = await import('../src/core/jobs.js');
  scheduler = await import('../src/core/scheduler.js');
  agent = await import('../src/core/agent.js');
  planning = await import('../src/core/planning.js');
  signals = await import('../src/core/signals.js');
  sdoh = await import('../src/core/sdoh.js');
});
beforeEach(async () => {
  jobs.stop();
  store.reset();
  const six = planning.occurrences(['06:00'], clock.now(), clock.now() + clock.DAY)[0].at;
  clock.advance(six - clock.now());
  await jobs.start({ intervalMs: 0 });
});

async function advanceTo(hhmm) {
  const at = planning.occurrences([hhmm], clock.now(), clock.now() + clock.DAY)[0].at;
  const by = at - clock.now() + 60_000;
  clock.advance(by);
  await jobs.afterAdvance(by);
}
const tap = (id, data) => agent.handleInbound({ patientId: id, buttonData: data });
const sdohTasks = (id) => store.listAlerts().filter((a) => a.patientId === id && a.kind === 'sdoh');
const lastOut = (id) => store.listMessages(id).filter((m) => m.direction === 'out').at(-1);

test('noon: screen starts with an intro and the first question (follow-up date filled in)', async () => {
  await advanceTo('12:00');
  const q = lastOut('p1');
  assert.match(q.text, /transporte para su cita de seguimiento el/);
  assert.deepEqual(q.buttons.flat().map((b) => b.data), ['sdoh:ride:yes', 'sdoh:ride:no']);
});

test('answers go one question at a time; needs -> resources, flags, ONE summary task', async () => {
  await sdoh.startScreen('p5');
  let r = await tap('p5', 'sdoh:ride:no');
  assert.match(r[0].text, /skipped or cut back on medicines/);
  r = await tap('p5', 'sdoh:cost:yes');
  r = await tap('p5', 'sdoh:food:no');
  r = await tap('p5', 'sdoh:help:no');
  assert.match(r[0].text, /Rides:.*211/s);
  assert.match(r[0].text, /Medicine costs/);
  assert.match(r[0].text, /Support at home/);
  assert.doesNotMatch(r[0].text, /Meals on Wheels/);
  const p = store.getPatient('p5');
  assert.deepEqual(p.sdoh.flags.sort(), ['medication_cost', 'social_isolation', 'transportation']);
  assert.ok(p.sdoh.screenedAt);
  const tasks = sdohTasks('p5');
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].title, /No ride to follow-up.*No one to help at home/);
  assert.deepEqual(signals.getSignals(p).sdohFlags.sort(), ['medication_cost', 'social_isolation', 'transportation']);
});

test('no needs -> warm thanks, no task', async () => {
  await sdoh.startScreen('p2');
  for (const d of ['sdoh:ride:yes', 'sdoh:cost:no', 'sdoh:food:no']) await tap('p2', d);
  const r = await tap('p2', 'sdoh:help:yes');
  assert.match(r[0].text, /great that you have support/);
  assert.equal(sdohTasks('p2').length, 0);
});

test('flags merge with refill barriers (no duplicates)', async () => {
  store.updatePatient('p5', { sdoh: { flags: ['transportation'] } });
  await sdoh.startScreen('p5');
  for (const d of ['sdoh:ride:no', 'sdoh:cost:no', 'sdoh:food:yes', 'sdoh:help:yes']) await tap('p5', d);
  assert.deepEqual(store.getPatient('p5').sdoh.flags.sort(), ['food_insecurity', 'transportation']);
});

test('out-of-order or repeated taps are ignored', async () => {
  await sdoh.startScreen('p5');
  const r = await tap('p5', 'sdoh:food:yes'); // not the current question... still pending, so accepted
  assert.ok(r[0].text);
  const again = await tap('p5', 'sdoh:food:yes'); // answered already
  assert.match(again[0].text, /Already/);
  assert.equal((await tap('p5', 'sdoh:bogus:yes'))[0].text.includes('Already'), true);
});

test('the screen is sent once per patient, never again after completion', async () => {
  await advanceTo('12:00');
  for (const d of ['sdoh:ride:yes', 'sdoh:cost:no', 'sdoh:food:no', 'sdoh:help:yes']) await tap('p5', d);
  clock.advance(3 * clock.DAY);
  await jobs.afterAdvance(3 * clock.DAY);
  assert.equal(scheduler.listJobs({ kind: 'sdoh_screen', patientId: 'p5' }).length, 1);
  const intros = store.listMessages('p5').filter((m) => /A few quick questions/.test(m.text));
  assert.equal(intros.length, 1);
});

test('not before day 2: a patient discharged today is screened tomorrow noon, not today', async () => {
  const { createPatient } = await import('../src/core/enroll.js');
  const p = createPatient({ name: 'New Patient' }); // discharged now (06:00 demo time)
  jobs.planAll(clock.now(), clock.now() + 48 * clock.HOUR);
  const [job] = scheduler.listJobs({ kind: 'sdoh_screen', patientId: p.id });
  assert.ok(Date.parse(job.dueAt) - clock.now() > 24 * clock.HOUR);
});

test('dashboard endpoint starts the screen now', async () => {
  const { createApp } = await import('../src/app.js');
  const server = createApp().listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/patients/p2/sdoh/start`, { method: 'POST' });
    assert.equal((await r.json()).sent, 2);
    assert.deepEqual(store.getPatient('p2').sdoh.pending, sdoh.QUESTIONS);
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/patients/nope/sdoh/start`, { method: 'POST' })).status, 404);
  } finally {
    server.close();
  }
});
