// Phase 2: bounded logs, job key index, and the unlinked-chat guard.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-retention-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, clock, scheduler;
const DAY = 24 * 60 * 60 * 1000;
before(async () => {
  store = await import('../src/store.js');
  clock = await import('../src/core/clock.js');
  scheduler = await import('../src/core/scheduler.js');
  scheduler.defineJob('ret_kind', { run: async () => {} });
});
beforeEach(() => {
  store.reset();
  Object.assign(store.RETENTION, { jobDays: 7, audit: 20_000, messages: 20_000, readings: 20_000 });
});

const job = (status, ranDaysAgo, key) => {
  const j = scheduler.schedule({ kind: 'ret_kind', patientId: 'p1', dueAt: clock.now() - ranDaysAgo * DAY, key });
  j.status = status;
  j.ranAt = new Date(clock.now() - ranDaysAgo * DAY).toISOString();
  return j;
};

test('prune drops finished jobs older than a week and keeps everything that still matters', () => {
  const old = ['done', 'missed', 'cancelled'].map((s, i) => job(s, 10, `old${i}`));
  const recent = job('done', 2, 'recent');
  const pending = job('pending', 30, 'pending-old');
  const failed = job('failed', 30, 'failed-old');
  const running = job('running', 30, 'running-old');
  const before = store.collection('jobs');
  store.prune();
  const keys = store.collection('jobs').map((j) => j.key);
  for (const j of old) assert.ok(!keys.includes(j.key), `${j.key} pruned`);
  for (const j of [recent, pending, failed, running]) assert.ok(keys.includes(j.key), `${j.key} kept`);
  assert.equal(store.collection('jobs'), before, 'same array object (references stay valid)');
});

test('audit, messages and readings are capped oldest-first', () => {
  Object.assign(store.RETENTION, { audit: 5, messages: 3, readings: 2 });
  const auditBefore = store.listAudit().length;
  for (let i = 0; i < 10; i++) store.audit('t', 'p1', { i });
  for (let i = 0; i < 6; i++) store.addMessage({ patientId: 'p1', direction: 'in', from: 'patient', text: `m${i}` });
  for (let i = 0; i < 4; i++) store.addReading({ patientId: 'p1', type: 'weight', value: 150 + i, source: 'self' });
  assert.ok(auditBefore + 10 > 5);
  store.prune();
  const a = store.listAudit();
  assert.equal(a.length, 5);
  assert.deepEqual(a.map((e) => e.data.i), [5, 6, 7, 8, 9], 'newest five survive');
  assert.deepEqual(store.collection('messages').slice(-3).map((m) => m.text), ['m3', 'm4', 'm5']);
  assert.equal(store.collection('messages').length, 3);
  assert.deepEqual(store.collection('readings').map((r) => r.value), [152, 153]);
});

test('prune returns how much it removed and is a no-op when nothing is over the caps', () => {
  assert.equal(store.prune(), 0);
});

test('schedule stays idempotent through reset, prune and direct array changes (key index never goes stale)', () => {
  const a = scheduler.schedule({ kind: 'ret_kind', patientId: 'p1', dueAt: clock.now() + DAY, key: 'idx' });
  assert.equal(scheduler.schedule({ kind: 'ret_kind', patientId: 'p1', dueAt: clock.now() + 2 * DAY, key: 'idx' }), a);
  store.reset();
  const b = scheduler.schedule({ kind: 'ret_kind', patientId: 'p1', dueAt: clock.now() + DAY, key: 'idx' });
  assert.notEqual(b, a, 'fresh db, fresh job');
  assert.equal(scheduler.listJobs({ key: 'idx' }).length, 1);
  // removed behind the scheduler's back (prune) -> the key can be scheduled again
  b.status = 'done';
  b.ranAt = new Date(clock.now() - 30 * DAY).toISOString();
  store.prune();
  const c = scheduler.schedule({ kind: 'ret_kind', patientId: 'p1', dueAt: clock.now() + DAY, key: 'idx' });
  assert.notEqual(c, b);
  assert.equal(scheduler.listJobs({ key: 'idx' }).length, 1);
});

test('findByChatId(null/undefined) never matches an unlinked patient', () => {
  assert.equal(store.getPatient('p2').chatId ?? null, null);
  assert.equal(store.findByChatId(null), null);
  assert.equal(store.findByChatId(undefined), null);
});
