// Phase 6: a patient's story on one axis, risk over time, and an audit export a clinic can hand to a
// compliance officer.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-timeline-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, clock, agent, scheduler, jobs, history, server, base;
before(async () => {
  store = await import('../src/store.js');
  clock = await import('../src/core/clock.js');
  agent = await import('../src/core/agent.js');
  scheduler = await import('../src/core/scheduler.js');
  jobs = await import('../src/core/jobs.js');
  history = await import('../src/insights/riskHistory.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());
beforeEach(() => {
  jobs.stop();
  store.reset();
});
const get = async (p) => {
  const r = await fetch(base + p);
  return { status: r.status, type: r.headers.get('content-type'), text: await r.text() };
};
const json = async (p) => JSON.parse((await get(p)).text);

// ---- risk history ----
test('GET /patients/:id/risk-history returns the trajectory, oldest first, and 404s for a stranger', async () => {
  history.recordRisk(store.getPatient('p1'));
  clock.advance(clock.DAY);
  history.recordRisk(store.getPatient('p1'));
  const rows = await json('/api/patients/p1/risk-history');
  assert.equal(rows.length, 2);
  assert.ok(Date.parse(rows[0].ts) < Date.parse(rows[1].ts));
  assert.ok(['Low', 'Med', 'High'].includes(rows[0].tier));
  assert.equal((await get('/api/patients/nope/risk-history')).status, 404);
});

test('a daily risk_snapshot job records every patient even when they say nothing', async () => {
  const handler = scheduler._handlers().get('risk_snapshot');
  assert.ok(handler, 'job kind exists');
  const job = scheduler.schedule({ kind: 'risk_snapshot', patientId: 'p2', dueAt: clock.now() - 1000, key: 'snap-test' });
  await scheduler.tick();
  assert.equal(job.status, 'done');
  assert.equal(history.riskHistory('p2').length, 1);
  const now = clock.now();
  jobs.planAll(now, now + 3 * clock.DAY);
  assert.ok(scheduler.listJobs({ kind: 'risk_snapshot', patientId: 'p2' }).length >= 2, 'planned for the coming days');
});

test('risk history is capped like the other logs', () => {
  const rows = store.collection('riskHistory');
  for (let i = 0; i < 25; i++) rows.push({ ts: clock.nowISO(), patientId: 'p1', score: i, tier: 'Low' });
  store.RETENTION.riskHistory = 10;
  store.prune();
  assert.equal(rows.length, 10);
  assert.equal(rows.at(-1).score, 24, 'newest kept');
  store.RETENTION.riskHistory = 20_000;
});

// ---- timeline ----
test('the timeline merges check-ins, messages, alerts, readings, risk and key events, newest first', async () => {
  await agent.handleInbound({ patientId: 'p1', text: 'tengo dolor de pecho' }); // RED: message, alert, escalation
  store.addReading({ patientId: 'p1', type: 'spo2', value: 97, source: 'device', device: 'test' });
  history.recordRisk(store.getPatient('p1'));
  const items = await json('/api/patients/p1/timeline');
  const kinds = new Set(items.map((i) => i.kind));
  for (const k of ['message', 'alert', 'reading', 'risk']) assert.ok(kinds.has(k), `has ${k}: ${[...kinds]}`);
  for (let i = 1; i < items.length; i++) assert.ok(Date.parse(items[i - 1].ts) >= Date.parse(items[i].ts), 'newest first');
  const alert = items.find((i) => i.kind === 'alert');
  assert.equal(alert.tier, 'RED');
  assert.ok(alert.alertId);
  const msg = items.find((i) => i.kind === 'message' && i.direction === 'in');
  assert.match(msg.text, /dolor de pecho/);
});

test('timeline items include the seeded check-in history with tier and reasons', async () => {
  const items = await json('/api/patients/p1/timeline?limit=500');
  const ci = items.filter((i) => i.kind === 'checkin');
  assert.ok(ci.length >= 3);
  assert.ok(ci.every((c) => ['GREEN', 'YELLOW', 'RED'].includes(c.tier)));
  assert.ok(ci.some((c) => Array.isArray(c.flags)));
});

test('timeline: limit, kinds filter, and a bad limit is clamped', async () => {
  const some = await json('/api/patients/p1/timeline?limit=3');
  assert.equal(some.length, 3);
  const only = await json('/api/patients/p1/timeline?kinds=checkin&limit=500');
  assert.ok(only.length > 0 && only.every((i) => i.kind === 'checkin'));
  const huge = await json('/api/patients/p1/timeline?limit=99999999');
  assert.ok(huge.length <= 1000);
  const junk = await json('/api/patients/p1/timeline?limit=abc');
  assert.ok(junk.length > 0 && junk.length <= 200, 'default applies');
  assert.equal((await get('/api/patients/nope/timeline')).status, 404);
});

test('timeline events are readable summaries, and noisy audit rows (parse traces) are left out', async () => {
  await agent.handleInbound({ patientId: 'p1', buttonData: 'cmd:checkin' });
  await agent.handleInbound({ patientId: 'p1', buttonData: 'ci:rf:none' }); // writes a parse_trace audit row
  const items = await json('/api/patients/p1/timeline?limit=500');
  assert.ok(!items.some((i) => i.kind === 'event' && i.type === 'parse_trace'));
  for (const e of items.filter((i) => i.kind === 'event')) assert.ok(typeof e.summary === 'string' && e.summary.length > 0, e.type);
});

// ---- audit CSV ----
test('GET /audit.csv exports audit rows as CSV with a header, patient names and escaped cells', async () => {
  store.audit('nurse_action', 'p1', { note: 'said "call back", twice\nnew line' });
  const res = await get('/api/audit.csv');
  assert.equal(res.status, 200);
  assert.match(res.type, /text\/csv/);
  const lines = res.text.split('\r\n');
  assert.equal(lines[0], 'ts,type,patientId,patientName,details');
  assert.ok(res.text.includes('Maria Garcia'));
  // details are JSON; CSV then doubles every quote and wraps the cell: it must parse back losslessly
  assert.ok(res.text.includes('""note"":""said \\""call back\\"", twice'), 'quotes doubled, field quoted');
  const cell = lines.find((l) => l.includes('nurse_action')).replace(/^[^,]*,nurse_action,p1,Maria Garcia,/, '');
  const unquoted = cell.slice(1, -1).replace(/""/g, '"');
  assert.equal(JSON.parse(unquoted).note, 'said "call back", twice\nnew line');
});

test('audit.csv filters by patient, type and date, and cannot be used for formula injection', async () => {
  store.audit('nurse_action', 'p1', { note: '=HYPERLINK("http://evil","x")' });
  store.audit('nurse_action', 'p2', { note: 'other patient' });
  store.audit('escalation', 'p1', { x: 1 });
  const p1 = (await get('/api/audit.csv?patientId=p1&type=nurse_action')).text;
  assert.ok(p1.includes('p1,') && !p1.includes('other patient') && !p1.includes('escalation,p1'));
  assert.ok(!/(^|,)"?=/.test(p1.split('\r\n').slice(1).join('\n').replace(/"\{[^]*$/g, '')), 'no cell starts with =');
  const future = (await get(`/api/audit.csv?from=${encodeURIComponent(new Date(Date.now() + 864e5 * 365).toISOString())}`)).text;
  assert.equal(future.split('\r\n').filter(Boolean).length, 1, 'header only');
  assert.equal((await get('/api/audit.csv?from=garbage')).status, 400);
});

test('every exported detail cell that begins with a formula character is neutralised', async () => {
  store.audit('x', 'p1', { a: 1 });
  const csv = (await get('/api/audit.csv?type=x')).text;
  const row = csv.split('\r\n')[1];
  assert.ok(row.startsWith(`${store.listAudit().at(-1).ts},x,p1,`));
  const { csvCell } = await import('../src/core/timeline.js');
  for (const bad of ['=1+1', '+1', '-1', '@SUM(A1)', '\tcmd']) assert.ok(csvCell(bad).replace(/^"/, '').startsWith("'"), bad);
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell(null), '');
});
