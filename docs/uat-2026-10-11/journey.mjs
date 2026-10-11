// A patient's whole 31 days on the demo clock: daily check-ins that actually get answered, reminders,
// lessons, the social-needs screen once, the weekly caregiver digest, escalation when things drift,
// and the end of monitoring.
import { boot, makeRunner, summary } from './lab.mjs';
const srv = await boot({ port: 3097 });
const R = makeRunner(srv);
const { mk, say, tap, patient, alerts, scenario } = R;
const out = (p, to = 'patient') => p.messages.filter((m) => m.direction === 'out' && m.to === to);

await scenario('K1 a month on the demo clock: one check-in a day, everything idempotent, monitoring ends on day 30', async ({ ok, note }) => {
  const id = await mk('Journey', { weights: [170, 170.3, 170.1, 170.4], caregiver: { name: 'Anna', relation: 'daughter', language: 'en' } });
  let answered = 0;
  let w = 170.4;
  for (let day = 1; day <= 31; day++) {
    await srv.post('/api/demo/advance', { hours: 24 });
    const p = await patient(id);
    if (p.checkin?.state && p.checkin.state !== 'idle') {
      // the patient answers the morning check-in like a real person would, with a slow drift upward from day 12
      w += day >= 12 && day <= 18 ? 0.8 : 0.05;
      await say(id, 'start').catch(() => {});
      let guard = 0;
      while (guard++ < 8) {
        const st = (await patient(id)).checkin?.state;
        if (!st || st === 'idle') break;
        if (st === 'redflags') await tap(id, 'ci:rf:none');
        else if (st === 'weight') await say(id, String(Math.round(w * 10) / 10));
        else if (st === 'breath') await tap(id, 'ci:breath:normal');
        else if (st === 'orthopnea') await tap(id, 'ci:orth:no');
        else if (st === 'swelling') await tap(id, 'ci:swell:none');
        else if (st === 'diuretic') await tap(id, 'ci:diu:yes');
        else if (st === 'spo2') await tap(id, 'ci:spo2:none');
        else break;
      }
      answered++;
    }
  }
  const p = await patient(id);
  const checkinPrompts = out(p).filter((m) => /Good morning/.test(m.text));
  note(`prompts ${checkinPrompts.length}, answered ${answered}, check-ins recorded ${p.checkins.length}`);
  ok('a check-in prompt roughly every day for ~30 days (not 0, not duplicated per day)', checkinPrompts.length >= 28 && checkinPrompts.length <= 33, checkinPrompts.length);
  const days = checkinPrompts.map((m) => m.ts.slice(0, 10));
  ok('never two check-in prompts on the same day', new Set(days).size === days.length, days.join(','));
  ok('the slow weight drift raised a YELLOW at some point', (await alerts(id)).some((a) => a.tier === 'YELLOW' && (a.kind ?? 'triage') === 'triage'), JSON.stringify((await alerts(id)).map((a) => a.tier + ':' + a.title.slice(0, 30))));
  ok('lessons were sent', out(p).some((m) => /tip|lesson|quiz|💡|📚/i.test(m.text)), '');
  ok('the social-needs screen was offered exactly once', out(p).filter((m) => /few quick questions so we can make sure/i.test(m.text)).length === 1, out(p).filter((m) => /quick questions/i.test(m.text)).length);
  ok('weekly caregiver digest(s) sent', out(p, 'caregiver').filter((m) => /Weekly|week/i.test(m.text)).length >= 3, out(p, 'caregiver').length);
  const jobs = (await srv.get(`/api/demo/jobs?patientId=${id}`)).json;
  ok('no failed jobs', jobs.filter((j) => j.status === 'failed').length === 0, JSON.stringify(jobs.filter((j) => j.status === 'failed').slice(0, 2)));
  const last = checkinPrompts.at(-1)?.ts;
  const disch = Date.parse(p.dischargedAt);
  ok('no check-in prompts after day 30', !last || Date.parse(last) - disch <= 31 * 86_400_000, `${last} vs discharge ${p.dischargedAt}`);
});

const o = summary();
await srv.stop();
process.exitCode = o.failed ? 1 : 0;
