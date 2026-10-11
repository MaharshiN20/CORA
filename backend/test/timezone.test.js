// A patient's day is their own (audit 2026-10-11: scheduling used the server's local time).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.HEARTBRIDGE_DB = `${process.env.TEMP ?? '/tmp'}/heartbridge-tz-${process.pid}.json`;
process.env.LLM_PROVIDER = 'none';
const plan = await import('../src/core/planning.js');

test('09:00 in Chicago / Tokyo / Kolkata is the right instant (summer and winter)', () => {
  const at = (ms, hhmm, tz) => new Date(plan.atLocalTime(Date.parse(ms), hhmm, tz)).toISOString();
  assert.equal(at('2026-07-15T12:00:00Z', '09:00', 'America/Chicago'), '2026-07-15T14:00:00.000Z'); // CDT = UTC-5
  assert.equal(at('2026-01-15T12:00:00Z', '09:00', 'America/Chicago'), '2026-01-15T15:00:00.000Z'); // CST = UTC-6
  assert.equal(at('2026-07-15T12:00:00Z', '09:00', 'Asia/Tokyo'), '2026-07-15T00:00:00.000Z');
  assert.equal(at('2026-07-15T12:00:00Z', '09:00', 'Asia/Kolkata'), '2026-07-15T03:30:00.000Z');
});

test('the calendar day of an instant depends on the zone', () => {
  const ms = Date.parse('2026-07-15T02:00:00Z');
  assert.equal(plan.localDayKey(ms, 'America/Los_Angeles'), '2026-07-14');
  assert.equal(plan.localDayKey(ms, 'Asia/Tokyo'), '2026-07-15');
  assert.equal(plan.localWeekday(ms, 'America/Los_Angeles'), 2); // Tuesday evening
  assert.equal(plan.localWeekday(ms, 'Asia/Tokyo'), 3);
});

test('DST: the spring-forward and fall-back days still have exactly one 09:00', () => {
  for (const [from, to] of [['2026-03-07T12:00:00Z', '2026-03-12T12:00:00Z'], ['2026-10-30T12:00:00Z', '2026-11-04T12:00:00Z']]) {
    const occ = plan.occurrences(['09:00'], Date.parse(from), Date.parse(to), 'America/Chicago');
    assert.equal(occ.length, 5);
    assert.equal(new Set(occ.map((o) => o.key)).size, 5);
    for (const o of occ) assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(o.at), '09:00');
  }
});

test('no timezone (or an unknown one) behaves exactly as before: the server\'s local time', () => {
  const ms = Date.parse('2026-07-15T12:00:00Z');
  assert.equal(plan.atLocalTime(ms, '09:00'), plan.atLocalTime(ms, '09:00', null));
  assert.equal(plan.tzOf({ timezone: 'Mars/Olympus' }), null);
  assert.equal(plan.tzOf({}), null);
  assert.equal(plan.tzOf({ timezone: 'Asia/Tokyo' }), 'Asia/Tokyo');
  assert.equal(plan.localDayKey(ms), plan.localDayKey(ms, null));
});

test('enrolling keeps a valid timezone and drops a bad one', async () => {
  const store = await import('../src/store.js');
  const { createPatient: enrollPatient } = await import('../src/core/enroll.js');
  const ok = enrollPatient({ name: 'Tz Ok', age: 70, timezone: 'America/Denver' });
  const bad = enrollPatient({ name: 'Tz Bad', age: 70, timezone: 'Nowhere/City' });
  assert.equal(store.getPatient(ok.id).timezone, 'America/Denver');
  assert.equal(store.getPatient(bad.id).timezone, undefined);
});

test('a Tokyo patient\'s daily check-in is planned for 09:00 Tokyo time', async () => {
  const store = await import('../src/store.js');
  const jobs = await import('../src/core/jobs.js');
  const scheduler = await import('../src/core/scheduler.js');
  store.reset();
  store.updatePatient('p5', { timezone: 'Asia/Tokyo', dischargedAt: new Date(Date.now() - 86_400_000).toISOString() });
  jobs.planPatient(store.getPatient('p5'), Date.now(), Date.now() + 2 * 86_400_000);
  const due = scheduler.listJobs({ kind: 'checkin_due', patientId: 'p5' });
  assert.ok(due.length >= 1);
  for (const j of due) assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(Date.parse(j.dueAt)), '09:00');
});
