// Insights (M2): exact metrics on a hand-built dataset, cohort determinism, ROI math,
// live journeys, and the HTTP API. No network, no LLM.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-insights-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, metrics, cohort, journeys, server, base;
before(async () => {
  store = await import('../src/store.js');
  metrics = await import('../src/insights/metrics.js');
  cohort = await import('../src/insights/cohort.js');
  journeys = await import('../src/insights/journeys.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());
beforeEach(() => store.reset());

// ---- hand-built dataset (4 days per journey) --------------------------------
const resp = (flags) =>
  flags.map((f, i) => ({ day: i + 1, responded: f !== 0, recoveredVia: f === 'n' ? 'nudge' : f === 'c' ? 'caregiver' : null }));
const J = [
  // en, 3/4 answered (engaged), day 2 recovered by a nudge, not readmitted, one RED true positive acked in 10 min
  { id: 'j1', source: 'cohort', language: 'en', responses: resp([1, 'n', 1, 0]), readmitted: false, rpmDays: 20,
    alerts: [{ tier: 'RED', kind: 'triage', status: 'resolved', outcome: 'true_positive', ackMinutes: 10 }] },
  // es, 1/4 (not engaged), readmitted, a false positive + an open unacked alert
  { id: 'j2', source: 'cohort', language: 'es', responses: resp([1, 0, 0, 0]), readmitted: true, rpmDays: 3,
    alerts: [
      { tier: 'YELLOW', kind: 'triage', status: 'resolved', outcome: 'false_positive', ackMinutes: 100 },
      { tier: 'YELLOW', kind: 'unreachable', status: 'open', outcome: null, ackMinutes: null },
    ] },
  // es, 4/4 (engaged), day 2 recovered via caregiver, ED visit avoided
  { id: 'j3', source: 'cohort', language: 'es', responses: resp([1, 'c', 1, 1]), readmitted: false, rpmDays: 3,
    alerts: [{ tier: 'YELLOW', kind: 'triage', status: 'resolved', outcome: 'ed_avoided', ackMinutes: 30 }] },
  // vi, 0/4 (not engaged), outcome unknown
  { id: 'j4', source: 'live', language: 'vi', responses: resp([0, 0, 0, 0]), readmitted: null, rpmDays: 3, alerts: [] },
];

test('impact: readmission engaged vs not, avoided, alert load, ack time, precision', () => {
  const m = metrics.impact(J, { nurses: 2, windowDays: 30 });
  assert.equal(m.patients, 4);
  assert.equal(m.engagedShare, 0.5);
  assert.deepEqual(m.readmission.engaged, { n: 2, readmitted: 0, rate: 0 });
  assert.deepEqual(m.readmission.notEngaged, { n: 1, readmitted: 1, rate: 1 }); // j4 unknown is excluded
  assert.deepEqual(m.readmission.overall, { n: 3, readmitted: 1, rate: 0.333 });
  assert.equal(m.projectedReadmissionsAvoided, 2); // (1 - 0) * 2 engaged
  assert.equal(m.alerts.total, 4);
  assert.equal(m.alerts.perNursePerDay, 0.067); // 4 / (2 nurses * 30 days)
  assert.equal(m.alerts.medianMinutesToAck, 30); // [10, 30, 100]
  assert.deepEqual(m.alerts.medianMinutesToAckByTier, { RED: 10, YELLOW: 65, INFO: null });
  assert.equal(m.alerts.precision, 0.667); // tp + ed_avoided out of 3 judged
});

test('impact on empty data is nulls, not zeros', () => {
  const m = metrics.impact([]);
  assert.equal(m.engagedShare, null);
  assert.equal(m.projectedReadmissionsAvoided, null);
  assert.equal(m.alerts.perNursePerDay, null);
  assert.equal(m.alerts.medianMinutesToAck, null);
  assert.equal(m.alerts.precision, null);
});

test('engagement: daily response rate, drop-off (retention), ladder recoveries', () => {
  const e = metrics.engagement(J, { windowDays: 4 });
  assert.equal(e.overallResponseRate, 0.5); // 8 / 16
  assert.deepEqual(e.byDay, [
    { day: 1, eligible: 4, responseRate: 0.75, retention: 0.75 },
    { day: 2, eligible: 4, responseRate: 0.5, retention: 0.5 },
    { day: 3, eligible: 4, responseRate: 0.5, retention: 0.5 },
    { day: 4, eligible: 4, responseRate: 0.25, retention: 0.25 },
  ]);
  assert.deepEqual(e.ladder, { recoveries: 2, viaNudge: 1, viaCaregiver: 1, patientsRecovered: 2 });
});

test('equity: same metrics per language + English vs non-English gap', () => {
  const q = metrics.equity(J);
  assert.deepEqual(Object.keys(q.byLanguage), ['en', 'es', 'vi']);
  assert.deepEqual(q.byLanguage.en, { patients: 1, responseRate: 0.75, engagedShare: 1, readmissionRate: 0, alertsPerPatient: 1, medianMinutesToAck: 10 });
  assert.deepEqual(q.byLanguage.es, { patients: 2, responseRate: 0.625, engagedShare: 0.5, readmissionRate: 0.5, alertsPerPatient: 1.5, medianMinutesToAck: 65 });
  assert.deepEqual(q.byLanguage.vi, { patients: 1, responseRate: 0, engagedShare: 0, readmissionRate: null, alertsPerPatient: 0, medianMinutesToAck: null });
  assert.equal(q.nonEnglish.responseRate, 0.417); // 5 / 12
  assert.equal(q.responseGap, 0.333);
});

test('ROI math with defaults and overrides', () => {
  const d = metrics.roi();
  assert.deepEqual(d.readmissions, { baseline: 205, avoided: 51.25 });
  assert.deepEqual(d.dollars, {
    readmissionCostAvoided: 768750, // 51.25 * 15000
    penaltyAvoided: 86250, // 0.0069 * 50M * 0.25
    tcmRevenue: 200960, // 800 * (0.4 * 298 + 0.6 * 220)
    rpmRevenue: 62400, // 600 * (52 + 52)
    total: 1118360,
  });
  assert.deepEqual(d.eligible, { tcmPatients: 800, rpmPatients: 600 });

  // Query-string style overrides (strings), junk ignored, reduction > 1 caps the penalty.
  const o = metrics.roi({ discharges: '200', reduction: '2', costPerReadmit: 'abc', bogus: 5 });
  assert.equal(o.inputs.discharges, 200);
  assert.equal(o.inputs.costPerReadmit, 15000);
  assert.equal(o.inputs.bogus, undefined);
  assert.equal(o.dollars.penaltyAvoided, 345000); // whole penalty, not 2x
});

test('measured rates prefill ROI (contact in first 2 days, >= 16 reading days)', () => {
  assert.deepEqual(metrics.measuredRates(J), { tcmContactRate: 0.75, rpmEligibleRate: 0.25 });
});

test('cohort generator is deterministic and realistic', () => {
  const a = cohort.generateCohort({ seed: 42 });
  const b = cohort.generateCohort({ seed: 42 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(cohort.generateCohort({ seed: 43 }), a);
  const c = cohort.generateCohort();
  assert.equal(c.length, 60);
  assert.deepEqual([...new Set(c.map((j) => j.language))].sort(), ['en', 'es', 'hi', 'vi', 'zh']);
  assert.ok(c.every((j) => j.source === 'cohort' && j.responses.length === 30 && j.patientId === null));
  const m = metrics.impact(c);
  assert.ok(m.readmission.overall.rate > 0.08 && m.readmission.overall.rate < 0.3, `overall ${m.readmission.overall.rate}`);
  assert.ok(m.readmission.engaged.rate < m.readmission.notEngaged.rate, 'engaged patients readmit less');
  const e = metrics.engagement(c);
  assert.ok(e.byDay[0].responseRate > e.byDay.at(-1).responseRate, 'engagement drops off over 30 days');
  assert.ok(Math.abs(metrics.equity(c).responseGap) < 0.15, 'languages served about equally');
});

test('live journey from a patient: responses by day, recoveries, ack time, refill gap', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-09-20T12:00:00Z');
  const d0 = now - 5 * DAY;
  const at = (days) => new Date(d0 + days * DAY).toISOString();
  const patient = {
    id: 'pX', language: 'es', dischargedAt: at(0),
    checkins: [{ ts: at(0.5) }, { ts: at(2.5) }],
    prescriptions: [{ med: 'Furosemide', expectedPickup: at(1), pickedUpAt: at(4) }, { med: 'Carvedilol', expectedPickup: at(4.5), pickedUpAt: null }],
    weights: [{ ts: at(0.5), lb: 150 }, { ts: at(2.5), lb: 151 }],
  };
  const alerts = [
    { patientId: 'pX', tier: 'YELLOW', kind: 'triage', status: 'acknowledged', outcome: null, ts: at(2.5),
      history: [{ ts: at(2.5), status: 'open' }, { ts: new Date(Date.parse(at(2.5)) + 12 * 60000).toISOString(), status: 'acknowledged' }] },
    { patientId: 'other', tier: 'RED', status: 'open', history: [{ ts: at(1), status: 'open' }] },
  ];
  const audit = [{ type: 'outreach_recovered', ts: at(2.6), data: { afterRung: 1, via: 'patient' } }];
  const j = journeys.liveJourney(patient, { alerts, audit, now });
  assert.equal(j.source, 'live');
  assert.equal(j.days, 5);
  assert.deepEqual(j.responses.map((r) => r.responded), [true, false, true, false, false]);
  assert.equal(j.responses[2].recoveredVia, 'nudge');
  assert.deepEqual(j.alerts, [{ tier: 'YELLOW', kind: 'triage', status: 'acknowledged', outcome: null, ackMinutes: 12 }]);
  assert.equal(j.readmitted, null);
  assert.equal(j.refillGapDays, 3);
  assert.equal(j.rpmDays, 2);
});

test('HTTP: every endpoint answers for each source; bad source is 400', async () => {
  for (const ep of ['impact', 'engagement', 'equity', 'roi']) {
    for (const source of ['cohort', 'live', 'all']) {
      const res = await fetch(`${base}/api/insights/${ep}?source=${source}`);
      assert.equal(res.status, 200, `${ep} ${source}`);
      assert.equal((await res.json()).source, source);
    }
  }
  assert.equal((await fetch(`${base}/api/insights/impact?source=nope`)).status, 400);
  assert.equal((await fetch(`${base}/api/insights`)).status, 200);
});

test('HTTP: cohort is created lazily, regenerates deterministically, never mixes with live patients', async () => {
  const impact = async () => (await (await fetch(`${base}/api/insights/impact?source=cohort`)).json());
  assert.equal((await impact()).patients, 60);
  const livePatients = (await (await fetch(`${base}/api/patients`)).json()).length;
  assert.equal(livePatients, store.listPatients().length);
  assert.equal((await (await fetch(`${base}/api/insights/impact?source=live`)).json()).patients, livePatients);

  const r = await fetch(`${base}/api/insights/cohort/regenerate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seed: 7, size: 25 }) });
  assert.deepEqual(await r.json(), { ok: true, seed: 7, size: 25 });
  const first = await impact();
  assert.equal(first.patients, 25);
  await fetch(`${base}/api/insights/cohort/regenerate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seed: 7, size: 25 }) });
  assert.deepEqual(await impact(), first);
});

test('HTTP: /roi uses measured TCM/RPM rates unless overridden', async () => {
  const m = await (await fetch(`${base}/api/insights/roi?source=cohort`)).json();
  assert.equal(m.inputs.tcmContactRate, m.measured.tcmContactRate);
  const o = await (await fetch(`${base}/api/insights/roi?source=cohort&tcmContactRate=0.5&discharges=100`)).json();
  assert.equal(o.inputs.tcmContactRate, 0.5);
  assert.equal(o.inputs.discharges, 100);
});
