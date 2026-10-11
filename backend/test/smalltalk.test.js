// Small talk: "thanks", "how are you" and "who are you?" used to get "Sorry, I didn't quite catch
// that" in a check-in, and a canned "I can help with questions about your heart..." or a bare
// check-in offer outside one. They now get an answer; everything that matters still goes first.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-smalltalk-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, agent, i18n, smalltalk;
before(async () => {
  store = await import('../src/store.js');
  agent = await import('../src/core/agent.js');
  i18n = await import('../src/core/i18n.js');
  smalltalk = await import('../src/core/smalltalk.js');
});
beforeEach(() => store.reset());

const say = (id, text, extra = {}) => agent.handleInbound({ patientId: id, text, ...extra });
const en = (key) => i18n.t('en', key);
const es = (key) => i18n.t('es', key);
const audits = (id) => store.listAudit().filter((a) => a.patientId === id && a.type === 'smalltalk');

test('"thanks" in the middle of a check-in gets "you\'re welcome", then the same question again', async () => {
  await agent.startCheckin('p5');
  const r = await say('p5', 'Thanks!');
  assert.equal(r.length, 1, 'one bubble');
  assert.ok(r[0].text.startsWith(en('smalltalk_thanks')), r[0].text);
  assert.ok(r[0].text.includes(en('ask_redflags')), 'the question is asked again');
  assert.ok(r[0].buttons?.flat().some((b) => b.data === 'ci:rf:none'), 'with its buttons');
  assert.doesNotMatch(r[0].text, /didn't quite catch/i);
  assert.equal(store.getPatient('p5').checkin.state, 'redflags', 'the check-in did not move');
  assert.deepEqual(store.getPatient('p5').checkin.answers, {}, 'and nothing was recorded as an answer');
  assert.deepEqual(audits('p5').map((a) => a.data), [{ via: 'rules', key: 'smalltalk_thanks' }]);
});

test('"how are you?" in the middle of a check-in is answered', async () => {
  await agent.startCheckin('p5');
  await say('p5', '', { buttonData: 'ci:rf:none' });
  const before = store.getPatient('p5').checkin.state;
  const r = await say('p5', 'hi, how are you today?');
  assert.ok(r[0].text.startsWith(en('smalltalk_how_are_you')), r[0].text);
  assert.equal(store.getPatient('p5').checkin.state, before);
});

test('"who are you and what can you do" says what the bot is: automated, not a person, 911 for emergencies', async () => {
  const r = await say('p5', 'who are you and what can you do');
  assert.equal(r.length, 1);
  assert.equal(r[0].text, en('smalltalk_about'));
  assert.match(r[0].text, /automated/i);
  assert.match(r[0].text, /not a person/i);
  assert.match(r[0].text, /911/);
  assert.ok(r[0].buttons?.flat().some((b) => b.data === 'cmd:checkin'), 'the check-in is one tap away');
  assert.ok(!store.getPatient('p5').checkin || store.getPatient('p5').checkin.state === 'idle', 'no check-in was started');
  assert.equal(store.listAlerts('p5').length, 0, 'and the nurse was not sent a "question"');
});

test('"are you a real person?" gets the same honest answer', async () => {
  for (const text of ['Are you a real person?', 'are you a nurse', 'What is your name?', 'who is this']) {
    const r = await say('p5', text);
    assert.equal(r[0].text, en('smalltalk_about'), text);
  }
});

test('outside a check-in "thank you so much" is answered instead of offering a check-in in words', async () => {
  const r = await say('p5', 'thank you so much 💙');
  assert.equal(r[0].text, en('smalltalk_thanks'));
  assert.ok(r[0].buttons?.flat().some((b) => b.data === 'cmd:checkin'));
});

test('Spanish gets Spanish, with an English copy for the nurse', async () => {
  const thanks = await say('p1', '¡Muchas gracias!');
  assert.equal(thanks[0].text, es('smalltalk_thanks'));
  assert.equal(thanks[0].textEn, en('smalltalk_thanks'));
  const who = await say('p1', '¿Quién eres?');
  assert.equal(who[0].text, es('smalltalk_about'));
  assert.match(who[0].text, /911/);
  const how = await say('p1', '¿Cómo está usted?');
  assert.equal(how[0].text, es('smalltalk_how_are_you'));
});

test('a fixed line only answers a whole message: anything else in it is read as before', async () => {
  for (const text of [
    'thanks, but my chest hurts',
    'who are you? my husband passed out',
    'how are you, I fainted this morning',
  ]) {
    store.reset();
    const r = await say('p5', text);
    assert.ok(r.some((x) => x.urgent), `"${text}" is still an emergency`);
  }
  for (const text of ['thanks I feel dizzy today', 'thank you for the pills', 'how are you supposed to take the water pill', 'who are you to tell me what to eat', 'thanks 911']) {
    assert.equal(smalltalk.cannedKey(text), null, text);
  }
});

test('"thanks, I feel dizzy" in a check-in records the dizziness', async () => {
  await agent.startCheckin('p5');
  const r = await say('p5', 'thanks, I feel dizzy');
  assert.doesNotMatch(r.map((x) => x.text).join('\n'), new RegExp(en('smalltalk_thanks').replace(/[!.]/g, '\\$&')));
  assert.equal(store.getPatient('p5').checkin.answers.dizzy, true);
});

test('during a RED lock "thanks" still gets "call 911"', async () => {
  const first = await say('p5', 'my chest hurts');
  assert.ok(first.some((x) => x.urgent));
  const r = await say('p5', 'thanks');
  assert.ok(r[0].urgent, 'the lock answers, not the small talk');
  assert.match(r[0].text, /911/);
  assert.equal(audits('p5').length, 0);
});

test('a caregiver and a proxy check-in are answered as before', async () => {
  const ack = await say('p5', 'thanks', { role: 'caregiver' });
  assert.equal(ack[0].text, i18n.t('en', 'caregiver_ack', { name: 'Dorothy' }));
  await say('p5', '', { role: 'caregiver', buttonData: 'cmd:proxy' });
  assert.equal(store.getPatient('p5').checkin.reporter, 'caregiver');
  const r = await say('p5', 'thanks', { role: 'caregiver' });
  assert.doesNotMatch(r.map((x) => x.text).join('\n'), /You're welcome/);
});

test('the fixed lines exist in English and Spanish', () => {
  for (const key of ['smalltalk_thanks', 'smalltalk_how_are_you', 'smalltalk_about']) {
    assert.notEqual(en(key), key, `${key} (en)`);
    assert.notEqual(es(key), en(key), `${key} (es)`);
  }
});
