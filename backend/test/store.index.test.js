// K11: per-patient indexes for messages, alerts, audit and readings. The index must always
// agree with a plain filter of the underlying array, whatever happened to that array.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-store-index-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, clock;
before(async () => {
  store = await import('../src/store.js');
  clock = await import('../src/core/clock.js');
});
beforeEach(() => {
  store.reset();
  Object.assign(store.RETENTION, { jobDays: 7, audit: 20_000, messages: 20_000, readings: 20_000 });
});

const IDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'nobody'];
const naive = (name, id) => store.raw()[name].filter((row) => row.patientId === id);

// Every indexed accessor, for every patient, against the plain filter (same rows, same order).
function assertInSync(label) {
  for (const id of IDS) {
    assert.deepEqual(store.listMessages(id), naive('messages', id), `${label}: messages ${id}`);
    assert.deepEqual(store.listAlerts(id), naive('alerts', id), `${label}: alerts ${id}`);
    assert.deepEqual(store.listAudit(id), naive('audit', id), `${label}: audit ${id}`);
    assert.deepEqual(store.listReadings(id), naive('readings', id), `${label}: readings ${id}`);
    assert.deepEqual(store.listReadings(id, 'spo2'), naive('readings', id).filter((r) => r.type === 'spo2'), `${label}: spo2 readings ${id}`);
  }
}

// A little of everything for two patients, through the store's own API.
function activity(tag = '') {
  for (const id of ['p1', 'p2']) {
    store.addMessage({ patientId: id, direction: 'in', from: 'patient', text: `hello ${id}${tag}` });
    store.addMessage({ patientId: id, direction: 'out', text: `reply ${id}${tag}` });
    store.audit('triage', id, { tag });
    store.addAlert({ patientId: id, tier: 'YELLOW', reasons: [`weight up ${tag}`] });
    store.addReading({ patientId: id, type: 'spo2', value: 95 });
    store.addReading({ patientId: id, type: 'weight', value: 170 });
  }
  store.audit('system', null, { tag }); // a row that belongs to no patient
}

test('the index agrees with a plain filter after the seed load and after writes through the API', () => {
  assertInSync('seed');
  activity('a');
  assertInSync('after writes');
  activity('b'); // the index is warm now: these go through the O(1) path
  assertInSync('after more writes');
  assert.equal(store.listMessages('p1').filter((m) => m.text.startsWith('hello')).length, 2);
});

test('order is kept: messages, audit and readings oldest first, alerts newest first', () => {
  for (let i = 0; i < 4; i++) {
    store.addMessage({ patientId: 'p3', direction: 'in', from: 'patient', text: `m${i}` });
    store.audit('note', 'p3', { i });
    store.addReading({ patientId: 'p3', type: 'hr', value: 60 + i });
    store.addAlert({ patientId: 'p3', tier: 'INFO', title: `a${i}`, reasons: [] });
    store.listAlerts('p3'); // read between writes so both the rebuild and the O(1) path are used
  }
  assert.deepEqual(store.listMessages('p3').slice(-4).map((m) => m.text), ['m0', 'm1', 'm2', 'm3']);
  assert.deepEqual(store.listAudit('p3').filter((e) => e.type === 'note').map((e) => e.data.i), [0, 1, 2, 3]);
  assert.deepEqual(store.listReadings('p3', 'hr').map((r) => r.value), [60, 61, 62, 63]);
  assert.deepEqual(store.listAlerts('p3').slice(0, 4).map((a) => a.title), ['a3', 'a2', 'a1', 'a0']);
});

test('after reset() nothing from before survives in the index', () => {
  activity();
  assertInSync('warm');
  const had = store.listMessages('p1').length;
  store.reset();
  assertInSync('after reset');
  assert.ok(store.listMessages('p1').length < had);
  assert.ok(!store.listMessages('p1').some((m) => m.text === 'hello p1'));
  assert.equal(store.listAlerts('p1').filter((a) => a.reasons[0] === 'weight up ').length, 0);
  activity('again');
  assertInSync('writes after reset');
});

test('after prune() the dropped rows are gone from the index too', () => {
  for (let i = 0; i < 12; i++) {
    store.audit('t', i % 2 ? 'p1' : 'p2', { i });
    store.addMessage({ patientId: i % 2 ? 'p1' : 'p2', direction: 'in', from: 'patient', text: `m${i}` });
    store.addReading({ patientId: i % 2 ? 'p1' : 'p2', type: 'weight', value: 150 + i });
  }
  assertInSync('before prune');
  Object.assign(store.RETENTION, { audit: 5, messages: 4, readings: 3 });
  assert.ok(store.prune() > 0);
  assertInSync('after prune');
  assert.deepEqual(store.listAudit('p1').map((e) => e.data.i), [7, 9, 11]);
  assert.deepEqual(store.listAudit('p2').map((e) => e.data.i), [8, 10]);
  assert.deepEqual(store.listMessages('p1').map((m) => m.text), ['m9', 'm11']);
  assert.deepEqual(store.listReadings('p2').map((r) => r.value), [160]);
  activity('post');
  assertInSync('writes after prune');
});

test('prune that drops exactly as many rows as were just added is still noticed', () => {
  Object.assign(store.RETENTION, { audit: 6 });
  for (let i = 0; i < 6; i++) store.audit('t', 'p1', { i });
  store.prune(); // caps the log at the six rows above
  assertInSync('capped');
  for (let i = 6; i < 9; i++) store.audit('t', 'p2', { i });
  store.prune(); // drops three, three were added: same length as the last time it was read
  assertInSync('same length, different rows');
  assert.deepEqual(store.listAudit('p1').map((e) => e.data.i), [3, 4, 5]);
  assert.deepEqual(store.listAudit('p2').map((e) => e.data.i), [6, 7, 8]);
});

test('after resetPatient() that patient starts clean and everyone else is untouched', () => {
  activity();
  const p2Messages = store.listMessages('p2');
  const p2Alerts = store.listAlerts('p2');
  assert.ok(store.listMessages('p1').some((m) => m.text === 'hello p1'));
  store.resetPatient('p1');
  assertInSync('after resetPatient');
  assert.deepEqual(store.listMessages('p1'), []);
  assert.deepEqual(store.listAlerts('p1'), []);
  assert.deepEqual(store.listAudit('p1'), []);
  assert.deepEqual(store.listReadings('p1'), []);
  assert.deepEqual(store.listMessages('p2'), p2Messages);
  assert.deepEqual(store.listAlerts('p2'), p2Alerts);
  store.addMessage({ patientId: 'p1', direction: 'in', from: 'patient', text: 'back again' });
  assert.deepEqual(store.listMessages('p1').map((m) => m.text), ['back again']);
});

test('direct pushes to collection() and raw() show up without going through the API', () => {
  assertInSync('warm');
  store.collection('audit').push({ id: 'x1', ts: clock.nowISO(), type: 'direct', patientId: 'p4', data: {} });
  assert.equal(store.listAudit('p4').at(-1).id, 'x1');
  store.collection('messages').push({ id: 'x2', ts: clock.nowISO(), patientId: 'p4', direction: 'in', text: 'direct' });
  assert.equal(store.listMessages('p4').at(-1).id, 'x2');
  store.raw().alerts.unshift({ id: 'x3', ts: clock.nowISO(), patientId: 'p4', tier: 'INFO', reasons: [], status: 'open' });
  assert.equal(store.listAlerts('p4')[0].id, 'x3');
  store.collection('readings').push({ id: 'x4', ts: clock.nowISO(), patientId: 'p4', type: 'hr', value: 70 });
  assert.equal(store.listReadings('p4', 'hr').at(-1).id, 'x4');
  assertInSync('after direct pushes');
  // and API writes right after a direct one still land in the right place
  store.audit('via-api', 'p4', {});
  store.collection('audit').push({ id: 'x5', ts: clock.nowISO(), type: 'direct', patientId: 'p4', data: {} });
  store.audit('via-api', 'p4', {});
  assert.deepEqual(store.listAudit('p4').slice(-3).map((e) => e.type), ['via-api', 'direct', 'via-api']);
  assertInSync('mixed');
});

test('a direct splice (same or different length) and a swapped array are noticed', () => {
  for (let i = 0; i < 5; i++) store.audit('t', 'p5', { i });
  assert.equal(store.listAudit('p5').filter((e) => e.type === 't').length, 5);
  const audit = store.collection('audit');
  audit.splice(audit.length - 1, 1); // remove the newest
  assertInSync('after a shrink');
  audit.splice(0, 1, { id: 'swap', ts: clock.nowISO(), type: 'swapped', patientId: 'p5', data: {} }); // replace the oldest: same length
  assertInSync('same length, first row swapped');
  audit.splice(audit.length - 1, 1, { id: 'swap2', ts: clock.nowISO(), type: 'swapped', patientId: 'p3', data: {} }); // replace the newest
  assertInSync('same length, last row swapped');
  store.raw().audit = audit.filter((e) => e.patientId !== 'p5'); // a brand new array
  assertInSync('array replaced');
  assert.deepEqual(store.listAudit('p5'), []);
});

test('rows changed in place are seen through the index (they are the same objects)', () => {
  const m = store.addMessage({ patientId: 'p1', direction: 'out', text: 'hi', delivery: 'pending' });
  assert.equal(store.listMessages('p1').at(-1).delivery, 'pending');
  store.updateMessage(m.id, { delivery: 'sent' });
  assert.equal(store.listMessages('p1').at(-1).delivery, 'sent');
  const a = store.addAlert({ patientId: 'p1', tier: 'RED', reasons: ['x'] });
  store.updateAlert(a.id, { status: 'acknowledged', by: 'RN' });
  assert.equal(store.listAlerts('p1')[0].status, 'acknowledged');
  assert.equal(store.listAlerts('p1')[0], store.getAlert(a.id));
});

test('what the accessors hand out is a copy: sorting or emptying it cannot corrupt the index', () => {
  activity('a');
  activity('b');
  for (const list of [() => store.listMessages('p1'), () => store.listAlerts('p1'), () => store.listAudit('p1'), () => store.listReadings('p1')]) {
    const first = list();
    assert.ok(first.length > 1);
    assert.notEqual(list(), first, 'a fresh array each call');
    first.reverse();
    first.length = 0;
    assert.ok(list().length > 1);
  }
  assertInSync('after callers mutated their copies');
});

test('return shapes are unchanged: no-argument calls give the live, complete arrays', () => {
  assert.equal(store.listAlerts(), store.raw().alerts);
  assert.equal(store.listAudit(), store.raw().audit);
  assert.equal(store.listAudit(null), store.raw().audit, 'a falsy id means "all", as before');
  assert.equal(store.listAudit(''), store.raw().audit);
  const a = store.addAlert({ patientId: 'p1', tier: 'INFO', reasons: [] });
  assert.equal(store.listAlerts()[0], a, 'newest first');
});

test('an id that is passed but undefined never returns everyone\'s alerts', () => {
  store.addAlert({ patientId: 'p1', tier: 'RED', reasons: ['x'] });
  const missing = {};
  assert.deepEqual(store.listAlerts(missing.id), []);
  assert.deepEqual(store.listAlerts(undefined), []);
  assert.deepEqual(store.listAlerts(null), []);
  assert.deepEqual(store.listMessages(undefined), []);
  assert.deepEqual(store.listReadings(undefined), []);
  assert.deepEqual(store.listAlerts('nobody'), []);
});

test('20k audit rows: per-patient reads no longer scan the whole log', () => {
  const PATIENTS = 2000;
  const ROWS = 20_000;
  const audit = store.collection('audit');
  audit.length = 0;
  const ts = clock.nowISO();
  for (let i = 0; i < ROWS; i++) audit.push({ id: `a${i}`, ts, type: 'triage', patientId: `q${i % PATIENTS}`, data: { i } });

  const time = (fn) => {
    const t0 = performance.now();
    const out = fn();
    return [performance.now() - t0, out];
  };
  const sweep = (read) => {
    let rows = 0;
    for (let p = 0; p < PATIENTS; p++) rows += read(`q${p}`).length;
    return rows;
  };

  const [buildMs] = time(() => store.listAudit('q0')); // first read builds the index
  const [indexedMs, indexedRows] = time(() => sweep((id) => store.listAudit(id)));
  const [naiveMs, naiveRows] = time(() => sweep((id) => audit.filter((e) => e.patientId === id)));

  assert.equal(indexedRows, ROWS);
  assert.equal(naiveRows, ROWS);
  assert.deepEqual(store.listAudit('q7').map((e) => e.data.i), audit.filter((e) => e.patientId === 'q7').map((e) => e.data.i));
  // 2000 reads: the scan does 40 million comparisons, the index 20 thousand row copies. Measured
  // about 1 ms against 900 ms; the bounds are loose so a busy CI machine can't make this flaky.
  assert.ok(indexedMs < naiveMs / 5, `indexed ${indexedMs.toFixed(1)} ms vs scan ${naiveMs.toFixed(1)} ms`);
  assert.ok(buildMs < 250, `building the index took ${buildMs.toFixed(1)} ms`);

  // Writes stay O(1) once the index is warm: 2000 appends + reads must not rebuild 2000 times.
  const [writeMs] = time(() => {
    for (let i = 0; i < 2000; i++) {
      store.audit('triage', `q${i}`, { extra: true });
      store.listAudit(`q${i}`);
    }
  });
  assert.equal(store.listAudit('q5').length, ROWS / PATIENTS + 1);
  assert.ok(writeMs < naiveMs, `2000 write+read pairs took ${writeMs.toFixed(1)} ms (a rebuild each would be ~${(buildMs * 2000).toFixed(0)} ms)`);
});
