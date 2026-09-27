// P1-2: scheduler engine + check-in planning.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-sched-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, clock, scheduler, jobs, server, base;
before(async () => {
  store = await import('../src/store.js');
  clock = await import('../src/core/clock.js');
  scheduler = await import('../src/core/scheduler.js');
  jobs = await import('../src/core/jobs.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());
beforeEach(() => {
  jobs.stop();
  store.reset();
});

// A scratch job kind for engine tests.
const calls = [];
function defineTestKinds() {
  scheduler.defineJob('test_once', { run: async (j) => calls.push(j.key) });
  scheduler.defineJob('test_collapse', { collapse: true, run: async (j) => calls.push(j.key) });
  scheduler.defineJob('test_fail', { run: async () => { throw new Error('boom'); } });
}

test('schedule is idempotent by key', () => {
  defineTestKinds();
  const a = scheduler.schedule({ kind: 'test_once', patientId: 'p1', dueAt: clock.now(), key: 'k1' });
  const b = scheduler.schedule({ kind: 'test_once', patientId: 'p1', dueAt: clock.now() + 5, key: 'k1' });
  assert.equal(a.id, b.id);
  assert.equal(scheduler.listJobs({ key: 'k1' }).length, 1);
  assert.throws(() => scheduler.schedule({ kind: 'nope', dueAt: clock.now() }), /unknown job kind/);
});

test('tick runs due jobs only, once', async () => {
  defineTestKinds();
  calls.length = 0;
  scheduler.schedule({ kind: 'test_once', patientId: 'p1', dueAt: clock.now() - 1000, key: 'due' });
  scheduler.schedule({ kind: 'test_once', patientId: 'p1', dueAt: clock.now() + clock.HOUR, key: 'later' });
  assert.deepEqual(await scheduler.tick(), { ran: 1, missed: 0, failed: 0 });
  assert.deepEqual(await scheduler.tick(), { ran: 0, missed: 0, failed: 0 });
  assert.deepEqual(calls, ['due']);
  assert.equal(scheduler.listJobs({ key: 'later' })[0].status, 'pending');
});

test('collapse: several overdue occurrences -> newest runs, older marked missed', async () => {
  defineTestKinds();
  calls.length = 0;
  for (const h of [3, 2, 1]) scheduler.schedule({ kind: 'test_collapse', patientId: 'p1', dueAt: clock.now() - h * clock.HOUR, key: `c${h}` });
  scheduler.schedule({ kind: 'test_collapse', patientId: 'p2', dueAt: clock.now() - clock.HOUR, key: 'other-patient' });
  assert.deepEqual(await scheduler.tick(), { ran: 2, missed: 2, failed: 0 });
  assert.deepEqual(calls.sort(), ['c1', 'other-patient']);
});

test('a failing job is recorded + audited and does not stop the others', async () => {
  defineTestKinds();
  calls.length = 0;
  scheduler.schedule({ kind: 'test_fail', patientId: 'p1', dueAt: clock.now() - 2, key: 'f' });
  scheduler.schedule({ kind: 'test_once', patientId: 'p1', dueAt: clock.now() - 1, key: 'ok' });
  assert.deepEqual(await scheduler.tick(), { ran: 1, missed: 0, failed: 1 });
  assert.equal(scheduler.listJobs({ key: 'f' })[0].error, 'boom');
  assert.equal(store.listAudit('p1').at(-1).type, 'job_failed');
});

test('cancel only touches pending jobs matching the filter', () => {
  defineTestKinds();
  scheduler.schedule({ kind: 'test_once', patientId: 'p1', dueAt: clock.now() + 1000, key: 'x1' });
  scheduler.schedule({ kind: 'test_once', patientId: 'p2', dueAt: clock.now() + 1000, key: 'x2' });
  assert.equal(scheduler.cancel({ kind: 'test_once', patientId: 'p1' }), 1);
  assert.equal(scheduler.listJobs({ key: 'x2' })[0].status, 'pending');
});

test('start() plans only future check-ins: no burst on server start', async () => {
  const summary = await jobs.start({ intervalMs: 0 });
  assert.deepEqual(summary, { ran: 0, missed: 0, failed: 0 });
  const pending = scheduler.listJobs({ kind: 'checkin_due', status: 'pending' });
  assert.ok(pending.length >= store.listPatients().length); // 48h horizon
  assert.ok(pending.every((j) => Date.parse(j.dueAt) > clock.now()));
});

test('advance 24h: every patient gets exactly one check-in; high risk collapses 2 -> 1', async () => {
  await jobs.start({ intervalMs: 0 });
  clock.advance(clock.DAY);
  const summary = await jobs.afterAdvance(clock.DAY);
  const patients = store.listPatients();
  // other job kinds (med reminders) run too; count check-ins specifically
  assert.equal(scheduler.listJobs({ kind: 'checkin_due', status: 'done' }).length, patients.length);
  assert.equal(summary.failed, 0);
  for (const p of patients) {
    const done = scheduler.listJobs({ kind: 'checkin_due', patientId: p.id, status: 'done' });
    assert.equal(done.length, 1, `${p.id} should get one check-in`);
    assert.notEqual(store.getPatient(p.id).checkin.state, 'idle', `${p.id} check-in started`);
    assert.ok(store.listMessages(p.id).some((m) => m.direction === 'out'), `${p.id} got a message`);
  }
  // Maria is High risk (09:00 + 19:00): one ran, one missed
  assert.equal(scheduler.listJobs({ kind: 'checkin_due', patientId: 'p1', status: 'missed' }).length, 1);
});

test('re-planning and restarting never duplicate jobs', async () => {
  await jobs.start({ intervalMs: 0 });
  const n = store.collection('jobs').length;
  jobs.planAll(clock.now(), clock.now() + 48 * clock.HOUR);
  jobs.stop();
  await jobs.start({ intervalMs: 0 });
  assert.equal(store.collection('jobs').length, n);
});

// Move the demo clock to the next local HH:MM without running jobs.
function jumpTo(hhmm) {
  const at = jobs.occurrences([hhmm], clock.now(), clock.now() + clock.DAY)[0].at;
  clock.advance(at - clock.now());
}

test('a check-in the patient is answering right now is not restarted', async () => {
  const agent = await import('../src/core/agent.js');
  jumpTo('08:30');
  await jobs.start({ intervalMs: 0 });
  await agent.startCheckin('p5');
  await agent.handleInbound({ patientId: 'p5', buttonData: 'ci:rf:none' });
  await agent.handleInbound({ patientId: 'p5', text: '140' }); // now on the breath step
  clock.advance(clock.HOUR); // 09:30: the 09:00 check-in comes due
  await jobs.afterAdvance(clock.HOUR);
  const job = scheduler.listJobs({ kind: 'checkin_due', patientId: 'p5', status: 'done' })[0];
  assert.match(job.result.skipped, /in progress/);
  assert.equal(store.getPatient('p5').checkin.state, 'breath');
});

test("yesterday's unfinished check-in is abandoned (audited) and a fresh one starts", async () => {
  const agent = await import('../src/core/agent.js');
  jumpTo('08:00');
  await jobs.start({ intervalMs: 0 });
  await agent.startCheckin('p5');
  await agent.handleInbound({ patientId: 'p5', buttonData: 'ci:rf:none' });
  await agent.handleInbound({ patientId: 'p5', text: '140' }); // stops on breath, never finishes
  clock.advance(clock.DAY + 2 * clock.HOUR); // next day 10:00 (09:00 check-in is ~25h after the stale one)
  await jobs.afterAdvance(clock.DAY + 2 * clock.HOUR);
  const p = store.getPatient('p5');
  assert.equal(p.checkin.state, 'redflags'); // fresh check-in from the top
  const abandoned = store.listAudit('p5').find((e) => e.type === 'checkin_abandoned');
  assert.equal(abandoned.data.partial.weightLb, 140);
});

test('patients past the 30-day monitoring window get no check-ins', () => {
  store.updatePatient('p5', { dischargedAt: new Date(clock.now() - 40 * clock.DAY).toISOString() });
  jobs.planAll(clock.now(), clock.now() + 48 * clock.HOUR);
  assert.equal(scheduler.listJobs({ kind: 'checkin_due', patientId: 'p5' }).length, 0);
  assert.ok(scheduler.listJobs({ kind: 'checkin_due', patientId: 'p1' }).length > 0);
});

test('occurrences() finds each local time exactly once per day in the window', () => {
  const from = jobs.atLocalTime(clock.now(), '00:00');
  const occ = jobs.occurrences(['09:00', '19:00'], from, from + 2 * clock.DAY);
  assert.equal(occ.length, 4);
  assert.equal(new Set(occ.map((o) => o.key)).size, 4);
});

test('http: advance returns the job summary; jobs list + tick + reset work', async () => {
  await jobs.start({ intervalMs: 0 });
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());
  const r = await post('/api/demo/advance', { hours: 24 });
  assert.ok(r.jobs.ran >= store.listPatients().length);
  assert.equal(r.jobs.failed, 0);
  const list = await (await fetch(`${base}/api/demo/jobs?patientId=p1&status=done&kind=checkin_due`)).json();
  assert.equal(list.length, 1);
  assert.deepEqual(await post('/api/demo/tick'), { ran: 0, missed: 0, failed: 0 });
  await post('/api/demo/reset');
  assert.equal(clock.offset(), 0);
  assert.ok(scheduler.listJobs({ status: 'pending' }).length > 0); // replanned after reset
});
