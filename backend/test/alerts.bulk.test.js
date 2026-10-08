// K14: PATCH /api/alerts, the bulk acknowledge / assign behind the dashboard's checkboxes.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-alerts-bulk-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, server, base;
before(async () => {
  store = await import('../src/store.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());
beforeEach(() => {
  store.reset();
  delete process.env.API_TOKEN;
});

const bulk = async (body, headers = {}) => {
  const res = await fetch(`${base}/api/alerts`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const single = async (id, body) => (await fetch(`${base}/api/alerts/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const yellow = (patientId, extra = {}) => store.addAlert({ patientId, tier: 'YELLOW', reasons: ['Weight up 2.4 lb'], ...extra });
const info = (patientId, extra = {}) => store.addTask({ patientId, kind: 'refill', title: 'Furosemide not picked up', ...extra });
const red = (patientId) => store.addAlert({ patientId, tier: 'RED', reasons: ['Chest pain'] });
const actions = (patientId) => store.listAudit(patientId).filter((e) => e.type === 'nurse_action');
const toPatient = (patientId) => store.listMessages(patientId).filter((m) => m.direction === 'out' && m.to === 'patient');

test('acknowledges several YELLOW and INFO alerts in one request, with history, assignee and audit rows', async () => {
  const [a, b, c] = [yellow('p2'), yellow('p3'), info('p4')];
  const res = await bulk({ ids: [a.id, b.id, c.id], status: 'acknowledged', assignee: 'Ana Lopez', by: 'Ana Lopez' });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.updated, res.body.failed], [3, 0]);
  assert.deepEqual(res.body.results.map((r) => [r.id, r.ok, r.alert.status, r.alert.assignee]), [a, b, c].map((x) => [x.id, true, 'acknowledged', 'Ana Lopez']));
  for (const x of [a, b, c]) {
    const now = store.getAlert(x.id);
    assert.equal(now.status, 'acknowledged');
    assert.deepEqual(now.history.map((h) => [h.status, h.by]), [['open', undefined], ['acknowledged', 'Ana Lopez']]);
    const rows = actions(x.patientId);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].data, { alertId: x.id, status: 'acknowledged', assignee: 'Ana Lopez', by: 'Ana Lopez', bulk: true });
  }
});

test('a RED alert is refused and left untouched; the rest of the batch still goes through', async () => {
  const [r, y] = [red('p1'), yellow('p2')];
  const res = await bulk({ ids: [r.id, y.id], status: 'acknowledged', by: 'Ana' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results[0], { id: r.id, ok: false, error: 'RED alerts are handled one at a time' });
  assert.equal(res.body.results[1].ok, true);
  assert.deepEqual([res.body.updated, res.body.failed], [1, 1]);
  const still = store.getAlert(r.id);
  assert.equal(still.status, 'open');
  assert.equal(still.assignee, null);
  assert.equal(still.history.length, 1);
  assert.equal(actions('p1').length, 0, 'no audit row for the refused RED');
  assert.equal(toPatient('p1').length, 0);
  assert.equal(store.getAlert(y.id).status, 'acknowledged');
});

test('RED cannot be bulk-assigned either', async () => {
  const r = red('p1');
  const res = await bulk({ ids: [r.id], assignee: 'Ana' });
  assert.deepEqual(res.body, { results: [{ id: r.id, ok: false, error: 'RED alerts are handled one at a time' }], updated: 0, failed: 1 });
  assert.equal(store.getAlert(r.id).assignee, null);
});

test('an unknown id is reported for that id only', async () => {
  const y = yellow('p2');
  const res = await bulk({ ids: ['no-such-alert', y.id], status: 'acknowledged' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results[0], { id: 'no-such-alert', ok: false, error: 'not found' });
  assert.equal(res.body.results[1].alert.status, 'acknowledged');
  assert.deepEqual([res.body.updated, res.body.failed], [1, 1]);
});

test('partial failures: every id gets its own result, in request order', async () => {
  const [y, r, done, i] = [yellow('p2'), red('p1'), yellow('p3'), info('p4')];
  await single(done.id, { status: 'resolved', outcome: 'true_positive' });
  const res = await bulk({ ids: [y.id, r.id, 'ghost', done.id, i.id], status: 'acknowledged', by: 'Ana' });
  assert.deepEqual(
    res.body.results.map((x) => [x.id, x.ok, x.error ?? null]),
    [
      [y.id, true, null],
      [r.id, false, 'RED alerts are handled one at a time'],
      ['ghost', false, 'not found'],
      [done.id, false, 'already resolved'],
      [i.id, true, null],
    ],
  );
  assert.deepEqual([res.body.updated, res.body.failed], [2, 3]);
  assert.equal(store.getAlert(done.id).status, 'resolved', 'a resolved alert is not re-opened');
});

test('it never moves an alert backwards: contacted stays contacted', async () => {
  const [contacted, acked] = [yellow('p2'), yellow('p3')];
  await single(contacted.id, { status: 'contacted', by: 'Ben' });
  await single(acked.id, { status: 'acknowledged', by: 'Ben' });
  const before = { p2: actions('p2').length, p3: actions('p3').length };
  const res = await bulk({ ids: [contacted.id, acked.id], status: 'acknowledged', by: 'Ana' });
  assert.deepEqual(res.body.results.map((r) => [r.ok, r.unchanged, r.alert.status]), [[true, true, 'contacted'], [true, true, 'acknowledged']]);
  assert.deepEqual([res.body.updated, res.body.failed], [0, 0]);
  assert.deepEqual({ p2: actions('p2').length, p3: actions('p3').length }, before, 'nothing changed, so nothing is audited');

  // with an assignee, only the assignee changes
  const again = await bulk({ ids: [contacted.id], status: 'acknowledged', assignee: 'Ana', by: 'Ana' });
  assert.equal(again.body.results[0].alert.status, 'contacted');
  assert.equal(again.body.results[0].alert.assignee, 'Ana');
  assert.deepEqual(actions('p2').at(-1).data, { alertId: contacted.id, assignee: 'Ana', by: 'Ana', bulk: true });
});

test('assign only: sets the assignee, keeps the status, tells no patient', async () => {
  const [a, b] = [yellow('p2'), info('p3')];
  const res = await bulk({ ids: [a.id, b.id], assignee: '  Ana Lopez ', by: 'Ana Lopez' });
  assert.deepEqual(res.body.results.map((r) => [r.alert.assignee, r.alert.status]), [['Ana Lopez', 'open'], ['Ana Lopez', 'open']]);
  assert.equal(store.getAlert(a.id).history.length, 1, 'no status change, no history entry');
  assert.equal(toPatient('p2').length, 0);
  // assigning to the same nurse again is a no-op
  const again = await bulk({ ids: [a.id, b.id], assignee: 'Ana Lopez' });
  assert.ok(again.body.results.every((r) => r.unchanged));
  assert.equal(actions('p2').length, 1);
});

test('the patient is told a nurse saw their update: once per alert, and once per patient per batch', async () => {
  const [first, second, other, task] = [yellow('p2'), yellow('p2', { kind: 'device', reasons: ['SpO2 91%'] }), yellow('p3'), info('p2')];
  const res = await bulk({ ids: [first.id, second.id, other.id, task.id], status: 'acknowledged', by: 'Nurse Kim' });
  assert.equal(res.body.updated, 4);
  assert.equal(toPatient('p2').length, 1, 'two alerts for one patient: one message, not two');
  assert.match(toPatient('p2')[0].text, /Nurse Kim/);
  assert.equal(toPatient('p3').length, 1);
  for (const a of [first, second, other]) assert.ok(store.getAlert(a.id).patientNotifiedAt, 'stamped, so it is never sent again');
  assert.equal(store.getAlert(task.id).patientNotifiedAt, undefined, 'INFO tasks never notify');
  assert.equal(store.listAudit('p2').filter((e) => e.type === 'nurse_ack_notice').length, 1);
  assert.ok(res.body.results.every((r) => r.alert.status === 'acknowledged'));
  assert.ok(res.body.results[1].alert.patientNotifiedAt, 'the answer carries the stamp too');

  // the same batch again, and a single PATCH afterwards: no second message
  await bulk({ ids: [first.id, second.id, other.id], status: 'acknowledged', by: 'Nurse Kim' });
  await single(second.id, { status: 'acknowledged', by: 'Nurse Kim' });
  assert.equal(toPatient('p2').length, 1);
  assert.equal(toPatient('p3').length, 1);
});

test('an alert the patient was already told about is not announced again by a bulk acknowledge', async () => {
  const a = yellow('p2');
  await single(a.id, { status: 'acknowledged', by: 'Ben' });
  assert.equal(toPatient('p2').length, 1);
  store.updateAlert(a.id, { status: 'open' }); // re-opened by hand
  const b = yellow('p2');
  await bulk({ ids: [a.id, b.id], status: 'acknowledged', by: 'Ana' });
  assert.equal(toPatient('p2').length, 2, 'one more message, for the new alert only');
});

test('duplicate ids are handled once', async () => {
  const y = yellow('p2');
  const res = await bulk({ ids: [y.id, y.id, y.id], status: 'acknowledged', by: 'Ana' });
  assert.equal(res.body.results.length, 1);
  assert.equal(actions('p2').length, 1);
  assert.equal(toPatient('p2').length, 1);
});

test('validation: ids, the 50-alert cap, status, names, and "nothing to do"', async () => {
  const y = yellow('p2');
  const rejects = async (body, pattern) => {
    const res = await bulk(body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match(res.body.error, pattern);
  };
  await rejects({ status: 'acknowledged' }, /ids must be/);
  await rejects({ ids: 'a1', status: 'acknowledged' }, /ids must be/);
  await rejects({ ids: [], status: 'acknowledged' }, /ids must be/);
  await rejects({ ids: [y.id, 7], status: 'acknowledged' }, /ids must be/);
  await rejects({ ids: [y.id, ''], status: 'acknowledged' }, /ids must be/);
  await rejects({ ids: Array.from({ length: 51 }, (_, i) => `a${i}`), status: 'acknowledged' }, /at most 50/);
  await rejects({ ids: [y.id], status: 'bogus' }, /status must be one of/);
  await rejects({ ids: [y.id], status: 'resolved' }, /only "acknowledged" can be set in bulk/);
  await rejects({ ids: [y.id], status: 'contacted' }, /only "acknowledged"/);
  await rejects({ ids: [y.id], status: 'open' }, /only "acknowledged"/);
  await rejects({ ids: [y.id], assignee: 42 }, /assignee must be/);
  await rejects({ ids: [y.id], assignee: '   ' }, /assignee must be/);
  await rejects({ ids: [y.id], assignee: 'x'.repeat(81) }, /assignee must be/);
  await rejects({ ids: [y.id], status: 'acknowledged', by: { name: 'Ana' } }, /by must be/);
  await rejects({ ids: [y.id] }, /nothing to do/);
  await rejects({ ids: [y.id], by: 'Ana' }, /nothing to do/);
  assert.equal(store.getAlert(y.id).status, 'open', 'a rejected request changes nothing');
  assert.equal(actions('p2').length, 0);
});

test('exactly 50 ids is accepted', async () => {
  const made = Array.from({ length: 50 }, (_, i) => info(`p${(i % 5) + 1}`));
  const res = await bulk({ ids: made.map((a) => a.id), status: 'acknowledged', by: 'Ana' });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 50);
});

test('it sits behind the API token like the single-alert PATCH, and that route still works', async () => {
  const [y, z] = [yellow('p2'), yellow('p3')];
  process.env.API_TOKEN = 'nurse-token';
  assert.equal((await bulk({ ids: [y.id], status: 'acknowledged' })).status, 401);
  assert.equal(store.getAlert(y.id).status, 'open');
  assert.equal((await bulk({ ids: [y.id], status: 'acknowledged' }, { Authorization: 'Bearer nurse-token' })).status, 200);
  delete process.env.API_TOKEN;
  const one = await single(z.id, { status: 'contacted', by: 'Ben' });
  assert.equal(one.status, 'contacted');
  assert.deepEqual(actions('p3').at(-1).data, { alertId: z.id, status: 'contacted', by: 'Ben' }, 'single rows carry no bulk flag');
});
