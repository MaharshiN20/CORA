// S5c (audit 2026-10-11): questions are answered, in and out of a check-in.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-ciquestion-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, agent;
before(async () => {
  store = await import('../src/store.js');
  agent = await import('../src/core/agent.js');
});
beforeEach(() => store.reset());
const say = (text) => agent.handleInbound({ patientId: 'p5', text });

test('a question in the middle of a check-in is answered, then the same question is asked again', async () => {
  await agent.startCheckin('p5');
  await agent.handleInbound({ patientId: 'p5', buttonData: 'ci:rf:none' });
  const before = store.getPatient('p5').checkin.state;
  const r = await say('How much salt can I eat?');
  const text = r.map((x) => x.text).join('\n');
  assert.doesNotMatch(text, /didn't quite catch/i);
  assert.match(text, /📄/, 'cited answer from the discharge instructions / guide');
  assert.equal(store.getPatient('p5').checkin.state, before, 'the check-in did not move');
});

test('an unanswerable question mid-check-in goes to the nurse and the check-in carries on', async () => {
  await agent.startCheckin('p5');
  const r = await say('Is the parking lot free on Sundays?');
  assert.match(r.map((x) => x.text).join('\n'), /nurse/i);
  assert.ok(store.listAlerts('p5').some((a) => a.kind === 'question'));
  assert.ok(store.getPatient('p5').checkin);
});

test('"What should I do when I feel short of breath walking?" is a question, not a symptom report', async () => {
  const r = await say('What should I do when I feel short of breath walking?');
  assert.ok(!store.getPatient('p5').checkin || store.getPatient('p5').checkin.state === 'idle', 'no check-in was started');
  assert.match(r.map((x) => x.text).join('\n'), /📄/);
});

test('"my ankles are more swollen, what should I do?" is still a symptom report', async () => {
  await say('my ankles are more swollen, what should I do?');
  assert.equal(store.getPatient('p5').checkin.answers.swelling, 'worse');
});
