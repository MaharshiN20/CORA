// Phase 2: the scheduler survives crashes, bad patients and flaky sends.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-schedrec-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, clock, scheduler, jobs;
before(async () => {
  store = await import('../src/store.js');
  clock = await import('../src/core/clock.js');
  scheduler = await import('../src/core/scheduler.js');
  jobs = await import('../src/core/jobs.js');
});
beforeEach(() => {
  jobs.stop();
  store.reset();
});

test('jobs left "running" by a crash are put back to pending at boot and then run', async () => {
  let ran = 0;
  scheduler.defineJob('rec_once', { run: async () => { ran++; } });
  const job = scheduler.schedule({ kind: 'rec_once', patientId: 'p1', dueAt: clock.now() - 1000, key: 'rec1' });
  job.status = 'running'; // what the file looks like after a crash mid-job
  assert.equal(scheduler.recoverInterrupted(), 1);
  assert.equal(job.status, 'pending');
  assert.ok(store.listAudit('p1').some((a) => a.type === 'job_recovered'));
  await scheduler.tick();
  assert.equal(ran, 1);
  assert.equal(job.status, 'done');
  assert.equal(scheduler.recoverInterrupted(), 0, 'nothing else to recover');
});

test('jobs.start() recovers interrupted jobs before the first tick', async () => {
  let ran = 0;
  scheduler.defineJob('rec_start', { run: async () => { ran++; } });
  const job = scheduler.schedule({ kind: 'rec_start', patientId: 'p1', dueAt: clock.now() - 1000, key: 'rec2' });
  job.status = 'running';
  await jobs.start({ intervalMs: 0 });
  assert.equal(ran, 1);
});

test('a handler with retries is retried later, with backoff, and ends done', async () => {
  let attempts = 0;
  scheduler.defineJob('rec_flaky', {
    retries: 2,
    retryDelayMs: 60_000,
    run: async () => {
      if (++attempts < 3) throw new Error('telegram down');
      return { sent: 1 };
    },
  });
  const job = scheduler.schedule({ kind: 'rec_flaky', patientId: 'p1', dueAt: clock.now() - 1000, key: 'rec3' });
  const err = console.error;
  console.error = () => {};
  try {
    assert.equal((await scheduler.tick()).failed, 1);
    assert.equal(job.status, 'pending');
    assert.ok(Date.parse(job.dueAt) > clock.now(), 'not retried immediately');
    assert.equal((await scheduler.tick()).ran, 0, 'waits out the backoff');
    clock.advance(120_000);
    assert.equal((await scheduler.tick()).failed, 1);
    assert.equal(job.status, 'pending');
    clock.advance(5 * 60_000);
    assert.equal((await scheduler.tick()).ran, 1);
  } finally {
    console.error = err;
  }
  assert.equal(job.status, 'done');
  assert.equal(attempts, 3);
});

test('retries run out: the job is marked failed with the last error', async () => {
  scheduler.defineJob('rec_dead', { retries: 1, retryDelayMs: 1000, run: async () => { throw new Error('nope'); } });
  const job = scheduler.schedule({ kind: 'rec_dead', patientId: 'p1', dueAt: clock.now() - 1000, key: 'rec4' });
  const err = console.error;
  console.error = () => {};
  try {
    await scheduler.tick();
    clock.advance(10_000);
    await scheduler.tick();
  } finally {
    console.error = err;
  }
  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'nope');
  assert.equal(job.attempts, 2);
});

test('handlers without retries keep the old behaviour: one failure is final', async () => {
  scheduler.defineJob('rec_plain', { run: async () => { throw new Error('boom'); } });
  const job = scheduler.schedule({ kind: 'rec_plain', patientId: 'p1', dueAt: clock.now() - 1000, key: 'rec5' });
  const err = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await scheduler.tick(), { ran: 0, missed: 0, failed: 1 });
  } finally {
    console.error = err;
  }
  assert.equal(job.status, 'failed');
});

test('check-in jobs are retried (a failed send must not lose the day\'s check-in)', () => {
  assert.equal(scheduler._handlers().get('checkin_due').retries, 2);
});

test('one malformed patient does not stop planning for everyone else', () => {
  store.updatePatient('p1', { weights: null, meds: null, caregiver: null });
  const now = clock.now();
  assert.doesNotThrow(() => jobs.planAll(now, now + 48 * clock.HOUR));
  assert.ok(scheduler.listJobs({ kind: 'checkin_due', patientId: 'p2' }).length > 0, 'others still planned');
});

test('a 09:00 check-in left unanswered does not block the 19:00 one (stale after 6 h, not 12)', async () => {
  const run = scheduler._handlers().get('checkin_due').run;
  const dueAt = new Date(clock.now()).toISOString();
  const started = (hoursBefore) => new Date(clock.now() - hoursBefore * clock.HOUR).toISOString();

  store.updatePatient('p2', { checkin: { state: 'breath', answers: {}, startedAt: started(2) } });
  assert.deepEqual(await run({ patientId: 'p2', dueAt, id: 'j', }), { skipped: 'checkin already in progress' }, 'mid-answer 2 h ago: leave it');

  store.updatePatient('p2', { checkin: { state: 'breath', answers: {}, startedAt: started(10) } });
  const res = await run({ patientId: 'p2', dueAt, id: 'j' });
  assert.ok(res.sent > 0, 'unfinished 10 h ago: abandoned and asked fresh');
  assert.ok(store.listAudit('p2').some((a) => a.type === 'checkin_abandoned'));
});

test('routine jobs stay quiet while the RED lock holds', () => {
  store.addAlert({ patientId: 'p1', tier: 'RED', kind: 'triage', title: 'chest pain', reasons: ['chest pain'] });
  for (const kind of ['checkin_due', 'outreach_step', 'refill_check', 'digest_weekly', 'med_reminder']) {
    const skip = scheduler._handlers().get(kind).skipIf?.({ patientId: 'p1' });
    assert.ok(skip, `${kind} is skipped during the lock`);
  }
  assert.ok(!scheduler._handlers().get('digest_weekly').skipIf({ patientId: 'p2' }), 'other patients unaffected');
});
