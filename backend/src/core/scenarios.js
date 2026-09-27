// Scripted demo scenarios (P4-15). One click on the Demo console plays a whole patient
// conversation through the real pipeline (handleInbound -> rules -> alerts -> caregiver), at
// a human pace, so the 3-minute pitch never waits on an AI provider or a phone.
//
//   list() -> [{ name, title, description, tier, patientId, steps }]
//   run(name, { delayMs = 1200, wait = false }) -> { name, patientId, steps, delayMs }
//
// Deterministic: every answer is a button or text the rules parse on their own, so a scenario
// plays the same with or without an LLM. Each run first puts its patient back to the seed
// state (store.resetPatient), so it can be replayed any number of times.
import * as store from '../store.js';
import * as clock from './clock.js';
import * as scheduler from './scheduler.js';
import * as channels from '../channels/index.js';
import { handleInbound, startCheckin } from './agent.js';
import { startLadder } from './outreach.js';
import { afterAdvance } from './jobs.js';

// Step kinds:
//   { start: true }                     scheduler-style check-in (sent + non-response ladder)
//   { text } / { button }               the patient (or { role: 'caregiver' }) answers
//   { when: 'orthopnea', ... }          only if the check-in is on that step (plans vary by risk)
//   { advance: hours }                  move the demo clock and run what became due
//   { pauseMs }                         extra pause before this step (reading time)
const SCENARIOS = [
  {
    name: 'dorothy',
    tier: 'GREEN',
    patientId: 'p5',
    title: '🟢 Dorothy: a stable day',
    description: 'Low-risk check-in by taps. GREEN, a self-care tip, and nothing for the nurse.',
    steps: [
      { start: true },
      { button: 'ci:rf:none' },
      { text: '139.8' },
      { button: 'ci:breath:normal' },
      { when: 'orthopnea', button: 'ci:orth:no' },
      { button: 'ci:swell:none' },
      { button: 'ci:diu:yes' },
      { when: 'spo2', text: '97' },
    ],
  },
  {
    name: 'maria',
    tier: 'YELLOW',
    patientId: 'p1',
    title: '🟡 Maria (Spanish): fluid building up',
    description: 'Weight +4.9 lb in a day and swollen ankles, typed in Spanish. YELLOW, daughter notified, and eligible for the standing diuretic order.',
    steps: [
      { start: true },
      { button: 'ci:rf:none' },
      { text: '179 libras' },
      { text: 'los tobillos están más hinchados', pauseMs: 600 },
      { button: 'ci:breath:exertion' },
      { when: 'orthopnea', button: 'ci:orth:no' },
      { when: 'swelling', button: 'ci:swell:worse' },
      { button: 'ci:diu:yes' },
      { when: 'spo2', text: '96' },
    ],
  },
  {
    name: 'thanh',
    tier: 'RED',
    patientId: 'p3',
    title: '🔴 Thanh (Vietnamese): fainted',
    description: 'Taps "Fainted" on the first question: 911 now, son Minh alerted, RED on the worklist. Then says he feels fine: the RED lock repeats 911.',
    steps: [
      { start: true },
      { button: 'ci:rf:fainted' },
      { text: 'Tôi thấy đỡ rồi, không cần gọi 911 đâu', pauseMs: 1500 },
    ],
  },
  {
    name: 'anil',
    tier: 'SILENT',
    patientId: 'p4',
    title: '📵 Anil (Hindi): no reply',
    description: 'Check-in goes unanswered. The demo clock jumps +2 h (reminder) and +4 h more (granddaughter Priya asked to check in). Moves the demo clock for everyone.',
    steps: [{ start: true }, { advance: 2, pauseMs: 800 }, { advance: 4, pauseMs: 800 }],
  },
];
const BY_NAME = new Map(SCENARIOS.map((s) => [s.name, s]));
const running = new Set(); // patientIds with a scenario in flight

export const list = () => SCENARIOS.map(({ steps, ...s }) => ({ ...s, steps: steps.length }));

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const httpError = (status, message) => Object.assign(new Error(message), { status });

async function exec(sc, step) {
  const id = sc.patientId;
  if (step.when && store.getPatient(id).checkin?.state !== step.when) return 'skipped';
  if (step.start) {
    const p = store.getPatient(id);
    for (const r of await startCheckin(id)) await channels.sendToPatient(p, r);
    startLadder(p, store.getPatient(id).checkin.startedAt);
    return 'check-in sent';
  }
  if (step.advance) {
    const byMs = step.advance * clock.HOUR;
    clock.advance(byMs);
    const s = await afterAdvance(byMs);
    return `clock +${step.advance}h (${s.ran} jobs)`;
  }
  await handleInbound({ patientId: id, role: step.role ?? 'patient', channel: 'sim', ...(step.button ? { buttonData: step.button } : { text: step.text }) });
  return step.button ?? step.text;
}

export async function run(name, { delayMs = 1200, wait = false } = {}) {
  const sc = BY_NAME.get(name);
  if (!sc) throw httpError(404, `unknown scenario "${name}"`);
  if (running.has(sc.patientId)) throw httpError(409, `a scenario for ${sc.patientId} is already running`);
  if (!store.resetPatient(sc.patientId)) throw httpError(404, `patient ${sc.patientId} not found`);
  scheduler.cancel({ kind: 'outreach_step', patientId: sc.patientId }); // no ladder left over from earlier
  running.add(sc.patientId);
  store.audit('scenario', sc.patientId, { name, event: 'started' });

  const play = (async () => {
    const log = [];
    for (const step of sc.steps) {
      await sleep(delayMs + (delayMs ? step.pauseMs ?? 0 : 0));
      log.push(await exec(sc, step));
    }
    store.audit('scenario', sc.patientId, { name, event: 'finished', steps: log });
    return log;
  })().finally(() => running.delete(sc.patientId));

  if (wait) await play;
  else play.catch((err) => console.error(`[scenario] ${name} failed:`, err.message));
  return { name, patientId: sc.patientId, steps: sc.steps.length, delayMs };
}
