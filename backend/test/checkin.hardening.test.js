// Phase 3: check-in dead ends and lost input, stale emergency taps, dose bookkeeping, button size.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-checkin-hard-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, agent, meds, pharmacy, clock, helpers;
before(async () => {
  store = await import('../src/store.js');
  agent = await import('../src/core/agent.js');
  meds = await import('../src/core/meds.js');
  pharmacy = await import('../src/core/pharmacy.js');
  clock = await import('../src/core/clock.js');
  helpers = await import('./helpers/checkin.js');
});
beforeEach(() => store.reset());

const say = (patientId, input) => agent.handleInbound({ patientId, ...(typeof input === 'string' ? { text: input } : input) });
const state = (id) => store.getPatient(id).checkin;

// ---- stale emergency taps ----
test('a stale "chest pain" button tapped with no check-in running is still an emergency', async () => {
  assert.equal(state('p1').state, 'idle');
  const [r] = await say('p1', { buttonData: 'ci:rf:chest' });
  assert.equal(r.urgent, true);
  assert.equal(store.listAlerts().find((a) => a.patientId === 'p1').tier, 'RED');
});
test('a stale "breathless at rest", "fainted" or "confused" tap is an emergency too', async () => {
  for (const data of ['ci:breath:rest', 'ci:rf:fainted', 'ci:rf:confused']) {
    store.reset();
    const [r] = await say('p1', { buttonData: data });
    assert.equal(r.urgent, true, data);
  }
});
test('a stale calm tap (none / normal / dizzy) just offers a check-in', async () => {
  for (const data of ['ci:rf:none', 'ci:breath:normal', 'ci:rf:dizzy', 'ci:swell:worse']) {
    store.reset();
    const [r] = await say('p1', { buttonData: data });
    assert.ok(!r.urgent, data);
    assert.ok(r.buttons?.flat().some((b) => b.data === 'cmd:checkin'), `${data} offers a check-in`);
    assert.equal(store.listAlerts().filter((a) => a.patientId === 'p1').length, 0);
  }
});

// ---- weight dead end ----
test('the weight question has a "can\'t weigh today" button, and tapping it moves on', async () => {
  const [first] = await say('p2', { buttonData: 'cmd:checkin' });
  await say('p2', { buttonData: 'ci:rf:none' });
  assert.equal(state('p2').state, 'weight');
  const weights = store.getPatient('p2').weights.length;
  const [ask] = await say('p2', 'hello?'); // re-asked
  assert.ok(ask.buttons?.flat().some((b) => b.data === 'ci:wt:skip'), 'skip button on the weight prompt');
  void first;
  await say('p2', { buttonData: 'ci:wt:skip' });
  assert.notEqual(state('p2').state, 'weight');
  await helpers.completeCheckin(agent, store, 'p2');
  assert.equal(state('p2').state, 'idle', 'the check-in completed');
  assert.equal(store.getPatient('p2').weights.length, weights, 'no weight was invented');
  assert.equal(store.getPatient('p2').checkins.at(-1).answers.weightSkipped, true);
});
test('"no scale" / "sin báscula" typed at the weight step skips it too', async () => {
  for (const text of ['I do not have a scale', "can't weigh myself today", 'no tengo bascula', 'hoy no me pude pesar']) {
    store.reset();
    await say('p2', { buttonData: 'cmd:checkin' });
    await say('p2', { buttonData: 'ci:rf:none' });
    await say('p2', text);
    assert.notEqual(state('p2').state, 'weight', text);
  }
});
test('a weight typed at the very first question is kept, not asked for again', async () => {
  await say('p2', { buttonData: 'cmd:checkin' });
  assert.equal(state('p2').state, 'redflags');
  await say('p2', '205 lbs, nothing scary today');
  const a = state('p2').answers;
  assert.equal(a.weightLb, 205);
  assert.equal(a.redflagsAsked, true, '"nothing scary" still answers the red-flag question');
  assert.notEqual(state('p2').state, 'weight');
});

// ---- a greeting with symptoms ----
test('"hola, mis tobillos están muy hinchados" starts a check-in AND keeps the swelling', async () => {
  await say('p1', 'hola, mis tobillos están muy hinchados');
  assert.notEqual(state('p1').state, 'idle');
  assert.equal(state('p1').answers.swelling, 'worse');
});
test('a bare "hola" still just starts the check-in', async () => {
  await say('p1', 'hola');
  assert.equal(state('p1').state, 'redflags');
});

// ---- diuretic answers do not clobber other doses ----
const todayDose = (id, med, hoursFromNow, taken) => ({ id, ts: new Date(clock.now() + hoursFromNow * clock.HOUR).toISOString(), med, diuretic: true, taken, source: 'reminder' });
test('an evening "no" does not flip the morning dose the patient already confirmed', () => {
  const p = { doses: [todayDose('am', 'furosemide', -1, true), todayDose('pm', 'furosemide', -0.1, null)] };
  const doses = meds.applyDiureticAnswer(p, false);
  assert.equal(doses.find((d) => d.id === 'am').taken, true, 'morning stays taken');
  assert.equal(doses.find((d) => d.id === 'pm').taken, false, 'the due, unanswered dose takes the answer');
});
test('a "yes" does not pre-mark a dose that is not due yet', () => {
  const p = { doses: [todayDose('am', 'furosemide', -2, null), todayDose('pm', 'furosemide', 6, null)] };
  const doses = meds.applyDiureticAnswer(p, true);
  assert.equal(doses.find((d) => d.id === 'am').taken, true);
  assert.equal(doses.find((d) => d.id === 'pm').taken, null, 'the evening dose is still pending');
});
test('with no dose due yet, a "yes" is recorded as its own check-in dose; with all answered it adds nothing', () => {
  const early = meds.applyDiureticAnswer({ doses: [todayDose('pm', 'furosemide', 6, null)], meds: [{ name: 'furosemide', diuretic: true }] }, true);
  assert.equal(early.length, 2);
  assert.equal(early.find((d) => d.source === 'checkin').taken, true);
  const answered = meds.applyDiureticAnswer({ doses: [todayDose('am', 'furosemide', -2, true)], meds: [{ name: 'furosemide', diuretic: true }] }, false);
  assert.equal(answered.length, 1);
  assert.equal(answered[0].taken, true, 'an answered dose is never overwritten');
});

// ---- Telegram's 64-byte button limit ----
test('refill buttons stay under 64 bytes and still work for long or odd medication names', async () => {
  const long = 'Sacubitril/valsartan (Entresto) 97 mg/103 mg film-coated tablets, 60 count';
  const accented = 'Furosémide: 40 mg';
  store.updatePatient('p1', {
    prescriptions: [long, accented].map((med) => ({ med, expectedPickup: new Date(clock.now() - 5 * clock.DAY).toISOString(), nudges: [] })),
  });
  const scheduler = await import('../src/core/scheduler.js');
  await import('../src/core/jobs.js');
  const job = scheduler.schedule({ kind: 'refill_check', patientId: 'p1', dueAt: clock.now() - 1, key: 'rx-long' });
  const handler = scheduler._handlers().get('refill_check');
  await handler.run(job);
  const nudges = store.listMessages('p1').filter((m) => m.buttons?.flat().some((b) => b.data.startsWith('rx:')));
  assert.ok(nudges.length >= 2);
  for (const m of nudges) for (const b of m.buttons.flat()) assert.ok(Buffer.byteLength(b.data) <= 64, `${b.data} is ${Buffer.byteLength(b.data)} bytes`);
  // tap "picked up" on each: the right prescription is updated
  for (const m of nudges) {
    const pick = m.buttons.flat().find((b) => b.data.endsWith(':picked'));
    await agent.handleInbound({ patientId: 'p1', buttonData: pick.data });
  }
  assert.ok(store.getPatient('p1').prescriptions.every((rx) => rx.pickedUpAt), 'both marked picked up');
  void pharmacy;
});
test('old-style rx buttons (med name inside) still work for messages already in a chat', async () => {
  const med = store.getPatient('p1').prescriptions?.[0]?.med ?? 'furosemide';
  if (!store.getPatient('p1').prescriptions?.length) {
    store.updatePatient('p1', { prescriptions: [{ med, expectedPickup: new Date(clock.now() - 5 * clock.DAY).toISOString() }] });
  }
  await agent.handleInbound({ patientId: 'p1', buttonData: `rx:${med}:picked` });
  assert.ok(store.getPatient('p1').prescriptions.find((r) => r.med === med).pickedUpAt);
});
