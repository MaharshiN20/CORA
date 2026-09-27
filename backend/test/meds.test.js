// P1-3: medication reminders, confirmations, adherence, and the triage link.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { completeCheckin } from './helpers/checkin.js';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-meds-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, clock, jobs, scheduler, agent, meds, planning, triage;
before(async () => {
  store = await import('../src/store.js');
  clock = await import('../src/core/clock.js');
  jobs = await import('../src/core/jobs.js');
  scheduler = await import('../src/core/scheduler.js');
  agent = await import('../src/core/agent.js');
  meds = await import('../src/core/meds.js');
  planning = await import('../src/core/planning.js');
  triage = await import('../src/core/triage.js');
});
// Every test starts at 06:00 local demo time, so results don't depend on when the suite runs.
beforeEach(async () => {
  jobs.stop();
  store.reset();
  const six = planning.occurrences(['06:00'], clock.now(), clock.now() + clock.DAY)[0].at;
  clock.advance(six - clock.now());
  await jobs.start({ intervalMs: 0 });
});

// Jump the demo clock to the next local HH:MM (+1 min) and run due jobs, like the demo console does.
async function advanceTo(hhmm) {
  const next = planning.occurrences([hhmm], clock.now(), clock.now() + clock.DAY)[0].at;
  const by = next - clock.now() + 60_000;
  clock.advance(by);
  return jobs.afterAdvance(by);
}
const lastOut = (id) => store.listMessages(id).filter((m) => m.direction === 'out').at(-1);
const tap = (id, data) => agent.handleInbound({ patientId: id, buttonData: data });
const pending = (id) => store.getPatient(id).doses.filter((d) => d.taken === null);

test('08:00 reminder lists that slot\'s meds with a button per med + "took them all"', async () => {
  await advanceTo('08:00');
  const msg = lastOut('p5');
  assert.match(msg.text, /08:00/);
  for (const m of ['Furosemide', 'Carvedilol', 'Lisinopril']) assert.match(msg.text, new RegExp(m));
  const data = msg.buttons.flat().map((b) => b.data);
  assert.equal(data.filter((d) => d.endsWith(':t')).length, 3);
  assert.ok(data.some((d) => d.startsWith('med:all:')));
  assert.ok(data.every((d) => Buffer.byteLength(d) <= 64));
  assert.equal(pending('p5').length, 3);
});

test('Spanish patient gets a Spanish reminder with an English twin', async () => {
  await advanceTo('08:00');
  const msg = store.listMessages('p1').filter((m) => m.text?.startsWith('💊')).at(-1);
  assert.match(msg.text, /Es hora de sus medicinas/);
  assert.match(msg.textEn, /Time for your/);
});

test('08:00 and 20:00 reminders are separate slots (evening only has Carvedilol)', async () => {
  await advanceTo('20:00');
  const msg = lastOut('p5');
  assert.match(msg.text, /Carvedilol/);
  assert.doesNotMatch(msg.text, /Furosemide/);
});

test('"took them all" confirms every dose in that reminder; repeat tap is a no-op', async () => {
  await advanceTo('08:00');
  const all = lastOut('p5').buttons.flat().find((b) => b.data.startsWith('med:all:')).data;
  const r = await tap('p5', all);
  assert.match(r[0].text, /All logged/);
  assert.equal(pending('p5').length, 0);
  assert.match((await tap('p5', all))[0].text, /Already logged/);
  assert.equal(meds.adherence(store.getPatient('p5')).overall, 1);
});

test('missing the water pill gives diuretic-specific advice; other meds get generic advice', async () => {
  await advanceTo('08:00');
  const btns = lastOut('p5').buttons.flat();
  const missFuro = btns.find((b) => b.label.includes('Furosemide') && b.data.endsWith(':m')).data;
  const missLis = btns.find((b) => b.label.includes('Lisinopril') && b.data.endsWith(':m')).data;
  assert.match((await tap('p5', missFuro)).at(-1).text, /water pill.*don't double up/i);
  assert.match((await tap('p5', missLis)).at(-1).text, /pharmacist/);
  const a = meds.adherence(store.getPatient('p5'));
  assert.equal(a.byMed.Furosemide.missed, 1);
  assert.equal(a.unconfirmed, 1); // Carvedilol still unanswered
  assert.equal(a.overall, 0);
});

test('unanswered reminders never count as missed doses (silence is not non-adherence)', async () => {
  await advanceTo('08:00');
  await advanceTo('08:00'); // next day, first reminder still unanswered
  const p = store.getPatient('p5');
  assert.equal(triage.consecutiveMissedDiureticDays(p.doses), 0);
  assert.equal(meds.adherence(p).overall, null);
});

test('med buttons work mid-check-in without disturbing it', async () => {
  await advanceTo('08:00');
  const took = lastOut('p5').buttons.flat().find((b) => b.data.startsWith('med:all:')).data;
  await agent.startCheckin('p5');
  await agent.handleInbound({ patientId: 'p5', text: '140' });
  await tap('p5', took);
  assert.equal(store.getPatient('p5').checkin.state, 'breath');
});

test('check-in water-pill answer merges into today\'s reminder dose (no duplicate)', async () => {
  await advanceTo('08:00');
  const before = store.getPatient('p5').doses.length;
  await advanceTo('09:00'); // scheduled check-in
  for (const x of ['140']) await agent.handleInbound({ patientId: 'p5', text: x });
  for (const b of ['ci:breath:normal', 'ci:swell:none', 'ci:rf:none', 'ci:diu:yes']) await tap('p5', b);
  const p = store.getPatient('p5');
  assert.equal(p.doses.length, before);
  assert.equal(p.doses.find((d) => d.diuretic).taken, true);
  assert.equal(p.doses.find((d) => d.diuretic).confirmedBy, 'checkin');
});

test('two days of missed water pills -> next check-in is YELLOW with missed_diuretic', async () => {
  for (let day = 0; day < 2; day++) {
    await advanceTo('08:00');
    const miss = lastOut('p5').buttons.flat().find((b) => b.label.includes('Furosemide') && b.data.endsWith(':m')).data;
    await tap('p5', miss);
  }
  await advanceTo('09:00');
  // Missed doses raise Dorothy's live risk, so the check-in may ask extra questions: answer by step.
  await completeCheckin(agent, store, 'p5', { weight: '140', diuretic: 'ci:diu:no' });
  const last = store.getPatient('p5').checkins.at(-1);
  assert.equal(last.tier, 'YELLOW');
  assert.ok(last.flags.some((f) => f.code === 'missed_diuretic'));
  assert.equal(store.listAlerts()[0].tier, 'YELLOW');
});

test('3-day jump: one reminder per slot, older ones marked missed (no reminder spam)', async () => {
  clock.advance(3 * clock.DAY);
  await jobs.afterAdvance(3 * clock.DAY);
  const reminders = store.listMessages('p5').filter((m) => m.text?.startsWith('💊'));
  assert.equal(reminders.length, 2); // latest 08:00 + latest 20:00
  assert.ok(scheduler.listJobs({ kind: 'med_reminder', patientId: 'p5', status: 'missed' }).length >= 4);
});

test('API exposes adherence on the patient detail', async () => {
  const { createApp } = await import('../src/app.js');
  const server = createApp().listen(0);
  try {
    const r = await (await fetch(`http://127.0.0.1:${server.address().port}/api/patients/p5`)).json();
    assert.deepEqual(Object.keys(r.adherence).sort(), ['byMed', 'overall', 'unconfirmed']);
    assert.ok('unconfirmedDoses7d' in r.signals);
  } finally {
    server.close();
  }
});
