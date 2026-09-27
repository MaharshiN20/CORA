// P1-5: non-response escalation ladder.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-outreach-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, clock, jobs, scheduler, agent, planning;
before(async () => {
  store = await import('../src/store.js');
  clock = await import('../src/core/clock.js');
  jobs = await import('../src/core/jobs.js');
  scheduler = await import('../src/core/scheduler.js');
  agent = await import('../src/core/agent.js');
  planning = await import('../src/core/planning.js');
});

// Start at 06:00 local demo time, then let the scheduled 09:00 check-in go out.
beforeEach(async () => {
  jobs.stop();
  store.reset();
  const six = planning.occurrences(['06:00'], clock.now(), clock.now() + clock.DAY)[0].at;
  clock.advance(six - clock.now());
  await jobs.start({ intervalMs: 0 });
  await advanceBy(3 * clock.HOUR + 60_000); // 09:01 -> check-in sent, ladder started
});

async function advanceBy(ms) {
  clock.advance(ms);
  return jobs.afterAdvance(ms);
}
const reminders = (id) => store.listMessages(id).filter((m) => m.to === 'patient' && m.textEn?.includes('just checking on you'));
const cgPings = (id) => store.listMessages(id).filter((m) => m.to === 'caregiver' && /hasn't answered/.test(m.text));
const unreachable = (id) => store.listAlerts().filter((a) => a.patientId === id && a.kind === 'unreachable');
const rungs = (id, status) => scheduler.listJobs({ kind: 'outreach_step', patientId: id, status });

test('a sent check-in schedules three rungs at +2h, +6h, +24h', () => {
  const pending = rungs('p5', 'pending');
  assert.equal(pending.length, 3);
  const start = Date.parse(store.getPatient('p5').checkin.startedAt);
  assert.deepEqual(pending.map((j) => (Date.parse(j.dueAt) - start) / clock.HOUR), [2, 6, 24]);
});

test('+2h: patient reminder re-asks the current question (in their language)', async () => {
  await advanceBy(2 * clock.HOUR);
  assert.equal(reminders('p5').length, 1);
  const last = store.listMessages('p5').filter((m) => m.to === 'patient').at(-1);
  assert.match(last.text, /weight/i); // current step re-asked
  const maria = store.listMessages('p1').filter((m) => m.to === 'patient' && /solo quería saber/.test(m.text));
  assert.equal(maria.length, 1);
  assert.equal(cgPings('p5').length, 0);
});

test('+6h: caregiver is asked to check in (caregiver language)', async () => {
  await advanceBy(6 * clock.HOUR);
  const ping = cgPings('p5');
  assert.equal(ping.length, 1);
  assert.match(ping[0].text, /Dorothy/);
  assert.equal(unreachable('p5').length, 0);
});

test('+24h: nurse task "unreachable" (YELLOW), once', async () => {
  await advanceBy(24 * clock.HOUR);
  const tasks = unreachable('p5');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].tier, 'YELLOW');
  assert.match(tasks[0].reasons.join(' '), /caregiver contacted/);
  assert.ok(store.listAudit('p5').some((e) => e.type === 'outreach' && e.data.rung === 3));
});

test('a reply before +2h cancels every rung silently', async () => {
  await agent.handleInbound({ patientId: 'p5', text: '140' });
  assert.equal(rungs('p5', 'pending').length, 0);
  assert.equal(rungs('p5', 'cancelled').length, 3);
  await advanceBy(24 * clock.HOUR + 1);
  assert.equal(reminders('p5').length, 0);
  assert.ok(!store.listAudit('p5').some((e) => e.type === 'outreach_recovered'));
});

test('a reply after the reminder = recovery: rest cancelled + outreach_recovered audited', async () => {
  await advanceBy(2 * clock.HOUR);
  await agent.handleInbound({ patientId: 'p5', text: '140' });
  const rec = store.listAudit('p5').find((e) => e.type === 'outreach_recovered');
  assert.equal(rec.data.afterRung, 1);
  assert.equal(rungs('p5', 'cancelled').length, 2);
  await advanceBy(22 * clock.HOUR + 1);
  assert.equal(cgPings('p5').length, 0);
  assert.equal(unreachable('p5').length, 0);
});

test('any patient tap (e.g. a med confirmation) also counts as a reply', async () => {
  await advanceBy(60_000);
  await agent.handleInbound({ patientId: 'p5', buttonData: 'med:nonexistent:t' });
  assert.equal(rungs('p5', 'pending').length, 0);
});

test('3 silent days -> one open unreachable task that accumulates, not three', async () => {
  for (let d = 0; d < 3; d++) await advanceBy(clock.DAY);
  const tasks = unreachable('p5');
  assert.equal(tasks.length, 1);
  assert.ok(tasks[0].silentDays >= 2);
  assert.ok(tasks[0].reasons.length >= 3);
});

test('no consented caregiver -> rung 2 skipped (audited), nurse rung still fires', async () => {
  store.updatePatient('p5', { caregiverConsent: false });
  await advanceBy(24 * clock.HOUR);
  assert.equal(cgPings('p5').length, 0);
  assert.equal(unreachable('p5').length, 1);
  assert.ok(store.listAudit('p5').some((e) => e.data?.skipped === 'no consented caregiver'));
});

test('manual "Start check-in" from the dashboard also starts a ladder', async () => {
  const { createApp } = await import('../src/app.js');
  const server = createApp().listen(0);
  try {
    await agent.handleInbound({ patientId: 'p2', text: 'hello' }); // cancel p2's scheduled ladder
    await fetch(`http://127.0.0.1:${server.address().port}/api/patients/p2/checkin`, { method: 'POST' });
    assert.equal(rungs('p2', 'pending').length, 3);
  } finally {
    server.close();
  }
});
