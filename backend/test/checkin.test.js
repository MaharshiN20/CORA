// End-to-end check-in flow through the public contract (handleInbound), no Telegram, no LLM.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-test-${process.pid}.json`);
delete process.env.ANTHROPIC_API_KEY;
delete process.env.TELEGRAM_BOT_TOKEN;

let store, agent;
before(async () => {
  store = await import('../src/store.js');
  agent = await import('../src/core/agent.js');
});
beforeEach(() => store.reset());

const say = (patientId, text) => agent.handleInbound({ patientId, text });
const tap = (patientId, buttonData) => agent.handleInbound({ patientId, buttonData });
const buttonsOf = (replies) => replies.flatMap((r) => (r.buttons ?? []).flat().map((b) => b.data));

test('risk tiers come from the seed', () => {
  assert.equal(store.getPatient('p1').riskTier, 'High'); // Garcia
  assert.equal(store.getPatient('p5').riskTier, 'Low'); // Smith
});

test('low-risk patient: full GREEN check-in via buttons (short plan, no orthopnea/SpO2)', async () => {
  let r = await agent.startCheckin('p5');
  assert.match(r[1].text, /weight/i);
  r = await say('p5', '140');
  assert.deepEqual(buttonsOf(r), ['ci:breath:normal', 'ci:breath:exertion', 'ci:breath:rest']);
  r = await tap('p5', 'ci:breath:normal');
  assert.ok(buttonsOf(r).includes('ci:swell:none')); // skipped orthopnea for Low risk
  r = await tap('p5', 'ci:swell:none');
  r = await tap('p5', 'ci:rf:none');
  r = await tap('p5', 'ci:diu:yes');
  assert.match(r[0].text, /stable/i);

  const p = store.getPatient('p5');
  assert.equal(p.lastTier, 'GREEN');
  assert.equal(p.checkin.state, 'idle');
  assert.equal(p.weights.at(-1).lb, 140);
  assert.equal(store.listAlerts().length, 0);
});

test('hero demo: Garcia in Spanish, free text fills several steps, ends YELLOW with alert', async () => {
  let r = await agent.startCheckin('p1');
  assert.match(r[0].text, /Buenos días Maria/);
  r = await say('p1', '177 libras');
  assert.match(r[0].text, /respiración/);
  // one message answers breath? no; answers orthopnea + swelling
  r = await say('p1', 'dormí con tres almohadas y los tobillos están más hinchados');
  // orthopnea + swelling filled; breath still missing, so it re-asks breath
  assert.ok(buttonsOf(r).includes('ci:breath:normal'));
  r = await tap('p1', 'ci:breath:exertion');
  assert.ok(buttonsOf(r).includes('ci:rf:none'));
  r = await tap('p1', 'ci:rf:none');
  r = await tap('p1', 'ci:diu:no');
  assert.ok(buttonsOf(r).includes('ci:spo2:none')); // High risk asks SpO2
  r = await say('p1', '94');
  assert.match(r[0].text, /enfermera/);

  const p = store.getPatient('p1');
  assert.equal(p.lastTier, 'YELLOW');
  const alert = store.listAlerts()[0];
  assert.equal(alert.tier, 'YELLOW');
  const joined = alert.reasons.join(' | ');
  assert.match(joined, /Weight up/);
  assert.match(joined, /pillows/);
  assert.match(joined, /swelling/);
  // caregiver got a message in the log
  assert.ok(store.listMessages('p1').some((m) => m.to === 'caregiver'));
  // outbound Spanish messages carry an English twin for the dashboard
  assert.ok(store.listMessages('p1').some((m) => m.direction === 'out' && m.textEn && m.textEn !== m.text));
});

test('chest pain button ends the check-in immediately with RED + 911', async () => {
  await agent.startCheckin('p2');
  await say('p2', '205');
  await tap('p2', 'ci:breath:normal');
  await tap('p2', 'ci:orth:no');
  await tap('p2', 'ci:swell:none');
  const r = await tap('p2', 'ci:rf:chest');
  assert.match(r[0].text, /911/);
  assert.equal(store.getPatient('p2').lastTier, 'RED');
  assert.equal(store.listAlerts()[0].tier, 'RED');
});

test('emergency phrase mid-check-in short-circuits to RED', async () => {
  await agent.startCheckin('p2');
  const r = await say('p2', "I can't breathe");
  assert.match(r[0].text, /911/);
  assert.equal(store.getPatient('p2').checkin.state, 'idle');
});

test('unprompted emergency message (no check-in running) escalates', async () => {
  const r = await say('p5', 'my chest hurts, chest pain since an hour');
  assert.match(r[0].text, /911/);
  assert.equal(store.listAlerts()[0].source, 'unprompted message');
});

test('bad weight input re-prompts without advancing', async () => {
  await agent.startCheckin('p5');
  const r = await say('p5', 'not sure');
  assert.match(r[0].text, /number/);
  assert.equal(store.getPatient('p5').checkin.state, 'weight');
});

test('random text outside a check-in offers to start one', async () => {
  const r = await say('p5', 'thanks!');
  assert.deepEqual(buttonsOf(r), ['cmd:checkin']);
  const r2 = await tap('p5', 'cmd:checkin');
  assert.match(r2[1].text, /weight/i);
});
