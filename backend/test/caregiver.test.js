// P1-7: caregiver proxy check-in, caregiver-reported emergencies, consent, weekly digest.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-cg-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, clock, jobs, scheduler, agent, planning, digest;
before(async () => {
  store = await import('../src/store.js');
  clock = await import('../src/core/clock.js');
  jobs = await import('../src/core/jobs.js');
  scheduler = await import('../src/core/scheduler.js');
  agent = await import('../src/core/agent.js');
  planning = await import('../src/core/planning.js');
  digest = await import('../src/core/digest.js');
});
beforeEach(async () => {
  jobs.stop();
  store.reset();
  const six = planning.occurrences(['06:00'], clock.now(), clock.now() + clock.DAY)[0].at;
  clock.advance(six - clock.now());
  await jobs.start({ intervalMs: 0 });
});

const cg = (id, x) => agent.handleInbound({ patientId: id, role: 'caregiver', ...(x.startsWith?.('ci:') || x.startsWith?.('cmd:') ? { buttonData: x } : { text: x }) });
const cgMessages = (id, re) => store.listMessages(id).filter((m) => m.to === 'caregiver' && m.direction === 'out' && re.test(m.text));

test('caregiver proxy check-in: English prompts for a Spanish patient, YELLOW tagged reporter=caregiver', async () => {
  let r = await cg('p1', 'cmd:proxy');
  assert.match(r[0].text, /checking in for Maria/);
  assert.match(r[1].text, /weight/i); // caregiver's language (en), not Maria's (es)
  await cg('p1', '177');
  await cg('p1', 'ci:breath:exertion');
  await cg('p1', 'ci:orth:yes');
  await cg('p1', 'ci:swell:worse');
  await cg('p1', 'ci:rf:none');
  await cg('p1', 'ci:diu:yes');
  r = await cg('p1', 'ci:spo2:none');
  assert.match(r[0].text, /asked Maria's nurse to call/);

  const p = store.getPatient('p1');
  assert.equal(p.checkins.at(-1).reporter, 'caregiver');
  const alert = store.listAlerts()[0];
  assert.equal(alert.tier, 'YELLOW');
  assert.equal(alert.reporter, 'caregiver');
  // the caregiver reported it, so they aren't sent a separate "HeartBridge update" about it
  assert.equal(cgMessages('p1', /HeartBridge update/).length, 0);
});

test('"hi" from a caregiver is acknowledged; "check in" starts a proxy check-in', async () => {
  const hi = await cg('p2', 'hi');
  assert.match(hi[0].text, /connected as a caregiver/);
  assert.equal(store.getPatient('p2').checkin.state, 'idle');
  const ci = await cg('p2', 'check in');
  assert.match(ci[0].text, /checking in for Robert/);
});

test('consent off: proxy refused politely', async () => {
  store.updatePatient('p2', { caregiverConsent: false });
  const r = await cg('p2', 'cmd:proxy');
  assert.match(r[0].text, /aren't turned on/);
  assert.equal(store.getPatient('p2').checkin.state, 'idle');
});

test('caregiver reporting an emergency in free text -> RED, reply tells them to call 911', async () => {
  const r = await cg('p2', 'he has chest pain and is sweating');
  assert.equal(r[0].urgent, true);
  assert.match(r[0].text, /CALL 911 NOW for Robert/);
  const a = store.listAlerts()[0];
  assert.equal(a.tier, 'RED');
  assert.equal(a.reporter, 'caregiver');
  assert.equal(a.source, 'caregiver message');
});

test('a patient-reported alert still notifies the caregiver (plain language, no thresholds)', async () => {
  await agent.handleInbound({ patientId: 'p2', text: 'chest pain' });
  const msg = cgMessages('p2', /HeartBridge alert for Robert/)[0];
  assert.ok(msg);
  assert.doesNotMatch(msg.text, /\(</);
});

test('proxy after the ladder pinged the caregiver = recovery via caregiver; ladder stops', async () => {
  const adv = async (ms) => { clock.advance(ms); await jobs.afterAdvance(ms); };
  await adv(3 * clock.HOUR + 60_000); // 09:01 check-in sent
  await adv(6 * clock.HOUR); // rungs 1 + 2 fired
  assert.equal(cgMessages('p5', /hasn't answered/).length, 1);
  await cg('p5', 'cmd:proxy');
  const rec = store.listAudit('p5').find((e) => e.type === 'outreach_recovered');
  assert.equal(rec.data.via, 'caregiver');
  assert.equal(rec.data.afterRung, 2);
  await adv(20 * clock.HOUR);
  assert.equal(store.listAlerts().filter((a) => a.patientId === 'p5' && a.kind === 'unreachable').length, 0);
});

test('digest summarises the week (weight trend, refills, alerts) in en and es', () => {
  const p = store.getPatient('p1');
  const en = digest.buildDigest(p, 'en');
  assert.match(en, /Weekly HeartBridge update for Maria/);
  assert.match(en, /172\.0 → 176\.8 lb \(\+4\.8 lb\)/);
  assert.match(en, /Still to pick up.*Furosemide/);
  assert.match(en, /No care-team alerts/);
  assert.match(digest.buildDigest(p, 'es'), /Resumen semanal/);
});

test('digest counts alerts and adherence once there is activity', async () => {
  await agent.handleInbound({ patientId: 'p2', text: 'chest pain' });
  const text = digest.buildDigest(store.getPatient('p2'), 'en');
  assert.match(text, /Care-team alerts: 1 \(1 urgent\)/);
});

test('POST /digest sends to the caregiver; GET previews; no caregiver -> not sent', async () => {
  const { createApp } = await import('../src/app.js');
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const sent = await (await fetch(`${base}/api/patients/p1/digest`, { method: 'POST' })).json();
    assert.equal(sent.sent, true);
    assert.equal(cgMessages('p1', /Weekly HeartBridge update/).length, 1);
    const preview = await (await fetch(`${base}/api/patients/p1/digest?lang=es`)).json();
    assert.match(preview.text, /Resumen semanal/);
    store.updatePatient('p5', { caregiver: { name: null, relation: null, language: 'en', chatId: null } });
    const none = await (await fetch(`${base}/api/patients/p5/digest`, { method: 'POST' })).json();
    assert.equal(none.sent, false);
  } finally {
    server.close();
  }
});

test('weekly digest job fires on Sunday 18:00', async () => {
  clock.advance(8 * clock.DAY);
  await jobs.afterAdvance(8 * clock.DAY);
  const done = scheduler.listJobs({ kind: 'digest_weekly', patientId: 'p1', status: 'done' });
  assert.equal(done.length, 1); // collapse: one digest even if the window spans more
  assert.equal(new Date(done[0].dueAt).getDay(), 0);
  assert.equal(new Date(done[0].dueAt).getHours(), 18);
});
