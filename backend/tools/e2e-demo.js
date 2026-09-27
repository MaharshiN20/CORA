// End-to-end demo run (P1-8): boots the API on a throwaway DB and drives the pitch
// story over HTTP exactly like the dashboard would, asserting each beat.
//
//   npm run e2e            (from backend/ or the repo root)
//   node tools/e2e-demo.js --quiet
//
// Also imported by test/e2e.test.js, so `npm run check` protects the demo path.
// No Telegram, no LLM: this is the "venue Wi-Fi died" fallback, and it must pass.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function runE2E({ log = console.log } = {}) {
  process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-e2e-${process.pid}-${Date.now()}.json`);
  process.env.LLM_PROVIDER = 'none';
  delete process.env.TELEGRAM_BOT_TOKEN;

  const store = await import('../src/store.js');
  const clock = await import('../src/core/clock.js');
  const jobs = await import('../src/core/jobs.js');
  const planning = await import('../src/core/planning.js');
  const { createApp } = await import('../src/app.js');

  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const steps = [];
  let failed = 0;

  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  const get = (p) => call('GET', p);
  const post = (p, body) => call('POST', p, body ?? {});

  async function step(title, fn) {
    try {
      const note = await fn();
      steps.push({ title, ok: true });
      log(`  ✓ ${title}${note ? `  (${note})` : ''}`);
    } catch (err) {
      failed++;
      steps.push({ title, ok: false, error: err.message });
      log(`  ✗ ${title}\n      ${err.message}`);
    }
  }
  const expect = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  // Advance the demo clock to the next local HH:MM (+1 min) through the real endpoint.
  const advanceTo = async (hhmm) => {
    const at = planning.occurrences([hhmm], clock.now(), clock.now() + clock.DAY)[0].at;
    const hours = (at - clock.now() + 60_000) / clock.HOUR;
    return post('/api/demo/advance', { hours });
  };
  const sim = (id, body) => post(`/api/patients/${id}/simulate`, body);
  const alertsFor = async (id) => (await get('/api/alerts')).filter((a) => a.patientId === id);

  try {
    log('HeartBridge end-to-end demo run');

    await step('reset demo and start the scheduler at 06:00 demo time', async () => {
      await post('/api/demo/reset');
      jobs.stop();
      const six = planning.occurrences(['06:00'], clock.now(), clock.now() + clock.DAY)[0].at;
      clock.advance(six - clock.now());
      await jobs.start({ intervalMs: 0 });
      const h = await get('/api/health');
      expect(h.ok && h.llm.provider === 'none', 'health not ok');
      return `${(await get('/api/patients')).length} patients`;
    });

    await step('08:00: medication reminders go out', async () => {
      const r = await advanceTo('08:00');
      const maria = await get('/api/patients/p1');
      expect(maria.messages.some((m) => m.text?.startsWith('💊')), 'no med reminder for Maria');
      return `${r.jobs.ran} jobs ran`;
    });

    await step('09:00: scheduled check-ins start (Maria in Spanish)', async () => {
      await advanceTo('09:00');
      const maria = await get('/api/patients/p1');
      expect(maria.checkin.state === 'weight', `Maria's check-in state is ${maria.checkin.state}`);
      expect(maria.messages.some((m) => /Buenos días Maria/.test(m.text)), 'no Spanish greeting');
    });

    await step('Maria answers in Spanish: weight, pillows, swollen ankles', async () => {
      await sim('p1', { text: '177 libras' });
      await sim('p1', { text: 'dormí con tres almohadas y los tobillos están más hinchados' });
      await sim('p1', { buttonData: 'ci:breath:exertion' });
      await sim('p1', { buttonData: 'ci:rf:none' });
      await sim('p1', { buttonData: 'ci:diu:yes' });
      const last = await sim('p1', { text: '94' });
      expect(/enfermera/.test(last[0].text), `unexpected closing reply: ${last[0].text}`);
    });

    await step('YELLOW alert lands on the nurse worklist with reasons', async () => {
      const a = (await alertsFor('p1')).find((x) => x.kind === 'triage');
      expect(a?.tier === 'YELLOW', 'no YELLOW triage alert for Maria');
      expect(a.reasons.some((r) => /Weight up/.test(r)) && a.reasons.some((r) => /pillows/.test(r)), 'missing reasons');
      return a.reasons.length + ' reasons';
    });

    await step('Maria\'s caregiver (daughter) is notified in plain language', async () => {
      const maria = await get('/api/patients/p1');
      expect(maria.messages.some((m) => m.to === 'caregiver' && /HeartBridge update for Maria/.test(m.text)), 'no caregiver update');
    });

    await step('Nurse acknowledges → Maria is told a nurse saw it; call scheduled', async () => {
      const a = (await alertsFor('p1')).find((x) => x.kind === 'triage');
      const acked = await call('PATCH', `/api/alerts/${a.id}`, { status: 'acknowledged', by: 'Nurse Kim' });
      expect(acked.patientNotifiedAt, 'patient not notified');
      await post('/api/patients/p1/message', { template: 'call_scheduled', time: '2:30 PM', from: 'Nurse Kim' });
      const maria = await get('/api/patients/p1');
      expect(maria.messages.some((m) => /le llamará a las 2:30 PM/.test(m.text)), 'no call-scheduled message');
    });

    await step('10:00: unfilled water pill nudge → "too expensive" → refill task', async () => {
      await advanceTo('10:00');
      const maria = await get('/api/patients/p1');
      expect(maria.messages.some((m) => /recogido su receta de Furosemide/.test(m.text)), 'no refill nudge');
      const r = await sim('p1', { buttonData: 'rx:Furosemide:cost' });
      expect(/Ayuda Adicional/.test(r[0].text), 'no cost help message');
      const task = (await alertsFor('p1')).find((x) => x.kind === 'refill');
      expect(task?.tier === 'YELLOW', 'refill task missing or not YELLOW');
    });

    await step('Dorothy texts "chest pain" → RED, 911 reply, alert', async () => {
      const r = await sim('p5', { text: 'I have chest pain' });
      expect(r[0].urgent && /911/.test(r[0].text), 'no urgent 911 reply');
      expect((await alertsFor('p5')).some((a) => a.tier === 'RED'), 'no RED alert');
    });

    await step('Silent patients: reminder (+2h) → caregiver (+6h) → unreachable task (+24h)', async () => {
      await post('/api/demo/advance', { hours: 24 });
      const alerts = await get('/api/alerts');
      const unreachable = alerts.filter((a) => a.kind === 'unreachable').map((a) => a.patientId);
      expect(unreachable.includes('p3'), `Nguyen not flagged unreachable (${unreachable})`);
      expect(!unreachable.includes('p1'), 'Maria answered but was flagged unreachable');
      const nguyen = await get('/api/patients/p3');
      expect(nguyen.messages.some((m) => m.to === 'caregiver' && /hasn't answered/.test(m.text)), 'Nguyen caregiver not pinged');
      return `unreachable: ${unreachable.join(', ')}`;
    });

    await step('Caregiver answers for Nguyen (proxy check-in) → ladder recovery', async () => {
      await sim('p3', { role: 'caregiver', buttonData: 'cmd:proxy' });
      for (const x of [{ text: '151' }, { buttonData: 'ci:breath:normal' }, { buttonData: 'ci:swell:none' }, { buttonData: 'ci:rf:none' }, { buttonData: 'ci:diu:yes' }]) {
        await sim('p3', { role: 'caregiver', ...x });
      }
      const p = await get('/api/patients/p3');
      expect(p.checkins.at(-1)?.reporter === 'caregiver', 'check-in not tagged caregiver');
      expect(p.audit.some((e) => e.type === 'outreach_recovered' && e.data.via === 'caregiver'), 'no caregiver recovery audited');
    });

    await step('Judge join links exist for every language; dashboard can enroll a patient', async () => {
      const links = await get('/api/join');
      expect(links.links.length >= 10, 'join links missing');
      const created = await post('/api/patients', { name: 'Judge Test', language: 'vi' });
      expect(created.linkCode, 'no link code');
    });

    await step('Weekly digest preview for Maria\'s daughter', async () => {
      const d = await get('/api/patients/p1/digest');
      expect(/Weekly HeartBridge update for Maria/.test(d.text) && /Care-team alerts/.test(d.text), 'digest content');
    });
  } finally {
    jobs.stop();
    server.close();
  }

  log(failed ? `\n${failed} step(s) FAILED of ${steps.length}` : `\nAll ${steps.length} steps passed ✅`);
  return { steps, failed };
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const quiet = process.argv.includes('--quiet');
  const { failed } = await runE2E({ log: quiet ? () => {} : console.log });
  if (quiet) console.log(failed ? `e2e: ${failed} failed` : 'e2e: all passed');
  process.exit(failed ? 1 : 0);
}
