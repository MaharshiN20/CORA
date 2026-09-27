// Audit repros (live testing, Sep 2026): everyday phrasing the check-in misread.
// Rules only, no LLM: these must hold even when every AI provider is down.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-test-colloquial-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, agent, parser;
before(async () => {
  store = await import('../src/store.js');
  agent = await import('../src/core/agent.js');
  parser = await import('../src/core/parser.js');
});
beforeEach(() => store.reset());

const say = (patientId, text) => agent.handleInbound({ patientId, text });
const tap = (patientId, buttonData) => agent.handleInbound({ patientId, buttonData });
const buttonsOf = (replies) => replies.flatMap((r) => (r.buttons ?? []).flat().map((b) => b.data));

// ---------- parser ----------
test('a usual pillow count is baseline, not orthopnea', () => {
  assert.equal(parser.parseFreeText('nah slept fine on my usual 2 pillows').orthopnea, undefined);
  assert.ok(parser.isBaselineSleep('nah slept fine on my usual 2 pillows'));
  assert.ok(parser.isBaselineSleep('same as always'));
  assert.ok(parser.isBaselineSleep('nope'));
  assert.ok(!parser.isBaselineSleep('needed 2 extra pillows'));
  assert.equal(parser.parseFreeText('my usual 3 pillows').orthopnea, undefined);
});

test('more pillows, the recliner and sitting up are orthopnea (en + es)', () => {
  for (const s of ['needed two more pillows last night', 'slept in the recliner', 'had to sleep sitting up', 'propped up on 4 pillows', 'dormí en el sillón', 'necesité más almohadas', 'slept with 3 pillows']) {
    assert.equal(parser.parseFreeText(s).orthopnea, true, s);
  }
  assert.equal(parser.parseFreeText('no extra pillows').orthopnea, undefined);
});

test('colloquial swelling is caught, a denial is not', () => {
  for (const s of ['my feet are like balloons', 'shoes are too tight', 'ankles are so swollen', 'tengo los pies como globos', 'los zapatos me quedan apretados']) {
    assert.equal(parser.parseFreeText(s).swelling, 'worse', s);
  }
  assert.equal(parser.parseFreeText('ankles are not swollen').swelling, 'none');
  assert.equal(parser.parseFreeText('no swelling').swelling, 'none');
});

test('weights: an impossible number is rejected, never "corrected"', () => {
  assert.equal(parser.parseWeight('2000'), null);
  assert.equal(parser.parseWeight('20000 lb'), null);
  assert.equal(parser.parseWeight('about 206 i think, scale\'s kinda old lol'), 206);
  assert.equal(parser.parseWeight('165.5kg'), 364.9);
  assert.equal(parser.parseWeight('176,4 libras'), 176.4);
  assert.equal(parser.parseWeight('slept 3 nights in the recliner, 176 today'), 176);
  assert.equal(parser.parseWeight('143 and honestly my chest is tight'), 143);
});

test('weights in words', () => {
  assert.equal(parser.parseWeight('one sixty two'), 162);
  assert.equal(parser.parseWeight('one hundred sixty-two pounds'), 162);
  assert.equal(parser.parseWeight('two oh five'), 205);
  assert.equal(parser.parseWeight('about one seventy I think'), 170);
  assert.equal(parser.parseWeight('ciento sesenta y dos'), 162);
  assert.equal(parser.parseWeight('seventy'), 70);
  assert.equal(parser.parseWeight('not sure'), null);
});

test('"not yet" is not a missed dose; "nah" is a no', () => {
  assert.ok(parser.isLater('not yet'));
  assert.ok(!parser.isNo('not yet'));
  assert.ok(parser.isLater('todavía no'));
  assert.ok(parser.isNo('nah'));
  assert.ok(parser.isNo('nope'));
  assert.ok(parser.isNo('forgot'));
});

// ---------- check-in flow ----------
async function atStep(id, step) {
  await agent.startCheckin(id);
  const answers = { redflags: 'ci:rf:none', weight: null, breath: 'ci:breath:normal', orthopnea: 'ci:orth:no', swelling: 'ci:swell:none' };
  for (let i = 0; i < 8 && store.getPatient(id).checkin.state !== step; i++) {
    const s = store.getPatient(id).checkin.state;
    if (s === 'weight') await say(id, String(store.getPatient(id).weights.at(-1).lb));
    else await tap(id, answers[s]);
  }
  assert.equal(store.getPatient(id).checkin.state, step);
}

test('"nah slept fine on my usual 2 pillows" answers the pillows question with no', async () => {
  await atStep('p2', 'orthopnea'); // Robert (Med risk) is asked about sleep
  await say('p2', 'nah slept fine on my usual 2 pillows');
  const p = store.getPatient('p2');
  assert.equal(p.checkin.answers.orthopnea, false);
  assert.equal(p.checkin.state, 'swelling');
});

test('sleep question has separate orthopnea and PND answers; PND raises YELLOW', async () => {
  const r = await agent.startCheckin('p2');
  assert.ok(buttonsOf(r).includes('ci:rf:none'));
  await atStep('p2', 'orthopnea');
  const prompt = store.listMessages('p2').filter((m) => m.direction === 'out').at(-1);
  assert.deepEqual(prompt.buttons.flat().map((b) => b.data), ['ci:orth:pillows', 'ci:orth:pnd', 'ci:orth:no']);
  await tap('p2', 'ci:orth:pnd');
  await tap('p2', 'ci:swell:none');
  await tap('p2', 'ci:diu:yes');
  const p = store.getPatient('p2');
  if (p.checkin.state === 'spo2') await tap('p2', 'ci:spo2:none');
  const done = store.getPatient('p2');
  assert.equal(done.lastTier, 'YELLOW');
  assert.ok(done.checkins.at(-1).flags.some((f) => f.code === 'pnd'));
});

test('volunteered symptoms mid-question are recorded and acknowledged, not ignored', async () => {
  await atStep('p5', 'weight');
  const r = await say('p5', 'my feet are like balloons and i been sleepin in the recliner 3 nights now');
  const a = store.getPatient('p5').checkin.answers;
  assert.equal(a.swelling, 'worse');
  assert.equal(a.orthopnea, true);
  assert.match(r[0].text, /noted that/);
  assert.match(r[0].text, /weight/i); // then the weight question again, not a verbatim repeat
});

test('"2000" is re-asked, never stored as 200', async () => {
  await atStep('p5', 'weight');
  const r = await say('p5', '2000');
  assert.equal(store.getPatient('p5').checkin.answers.weightLb, undefined);
  assert.equal(store.getPatient('p5').checkin.answers.weightPending, undefined);
  assert.match(r[0].text, /number/);
});

test('a new number (even in words) replaces a weight awaiting confirmation', async () => {
  await atStep('p5', 'weight'); // last 139.9
  let r = await say('p5', '165.5kg');
  assert.deepEqual(buttonsOf(r), ['ci:wconf:yes', 'ci:wconf:no']);
  r = await say('p5', 'one forty two');
  assert.equal(store.getPatient('p5').checkin.answers.weightLb, 142);
  assert.match(r[0].text, /breathing/i);
});

test('"not yet" to the water pill finishes the check-in without a missed dose', async () => {
  await atStep('p5', 'diuretic');
  const prompt = store.listMessages('p5').filter((m) => m.direction === 'out').at(-1);
  assert.deepEqual(prompt.buttons.flat().map((b) => b.data), ['ci:diu:yes', 'ci:diu:later', 'ci:diu:no']);
  await say('p5', 'not yet, after breakfast');
  const p = store.getPatient('p5');
  assert.equal(p.checkin.state, 'idle');
  assert.equal(p.lastTier, 'GREEN');
  assert.ok(!p.doses.some((d) => d.diuretic && d.taken === false));
});

test('an answer we cannot read gets "didn\'t catch that" plus the buttons, not a verbatim repeat', async () => {
  await atStep('p5', 'breath');
  const r = await say('p5', 'hmm');
  assert.match(r[0].text, /didn't quite catch/);
  assert.deepEqual(buttonsOf(r), ['ci:breath:normal', 'ci:breath:exertion', 'ci:breath:rest']);
});

test('a medication-change question mid-check-in goes to the nurse and the check-in continues', async () => {
  await atStep('p5', 'breath');
  const r = await say('p5', 'can I skip my water pill today?');
  assert.match(r[0].text, /nurse/);
  assert.ok(buttonsOf(r).includes('ci:breath:normal'));
  assert.equal(store.getPatient('p5').checkin.state, 'breath');
  assert.ok(store.listAlerts().some((a) => a.kind === 'question' && a.dosing));
});

test('a chest-pain tap on the first question goes straight to 911', async () => {
  await agent.startCheckin('p5');
  const r = await tap('p5', 'ci:rf:chest');
  assert.match(r[0].text, /911/);
  assert.equal(store.getPatient('p5').lastTier, 'RED');
});
