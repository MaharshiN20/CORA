// Phase 4: delivery you can trust. A failed send is queued and retried (not silently dropped), the
// message log says what really happened, an undelivered alert is flagged, and nurses have a
// fallback channel.
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-delivery-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, clock, channels, escalation;
before(async () => {
  store = await import('../src/store.js');
  clock = await import('../src/core/clock.js');
  channels = await import('../src/channels/index.js');
  escalation = await import('../src/core/escalation.js');
});

// A fake adapter that records sends and fails on demand.
function fake(name, { enabled = true } = {}) {
  const a = { name, sent: [], failing: false, isEnabled: () => enabled, async send(address, reply) {
    if (a.failing) throw new Error(`${name} is down`);
    a.sent.push({ address, text: reply.text });
  } };
  return a;
}
let tg, sms;
beforeEach(() => {
  store.reset();
  tg = fake('telegram');
  sms = fake('sms');
  channels.setAdapter('telegram', tg);
  channels.setAdapter('sms', sms);
  channels.setAdapter('whatsapp', fake('whatsapp', { enabled: false }));
  delete process.env.NURSE_CHAT_ID;
  delete process.env.NURSE_PHONE;
  console.error = quietError;
});
const realError = console.error;
function quietError() {}
afterEach(() => {
  channels.resetAdapters();
  console.error = realError;
});

const linked = (patch = {}) => {
  store.updatePatient('p1', { chatId: 111, phone: null, channel: 'telegram', ...patch });
  return store.getPatient('p1');
};
const lastMsg = () => store.listMessages('p1').at(-1);
const outbox = () => store.collection('outbox');

test('a delivered message is logged as sent', async () => {
  assert.equal(await channels.sendToPatient(linked(), { text: 'hello' }), true);
  assert.equal(lastMsg().delivery, 'sent');
  assert.equal(outbox().length, 0);
});

test('a failed send is logged as queued, put in the outbox, and delivered by the next flush after the backoff', async () => {
  tg.failing = true;
  assert.equal(await channels.sendToPatient(linked(), { text: 'take your pill' }), false);
  assert.equal(lastMsg().delivery, 'queued');
  assert.equal(outbox().length, 1);
  assert.equal(outbox()[0].status, 'pending');

  tg.failing = false;
  assert.equal((await channels.flushOutbox()).sent, 0, 'not due yet: the backoff is respected');
  clock.advance(3 * 60_000);
  const res = await channels.flushOutbox();
  assert.equal(res.sent, 1);
  assert.deepEqual(tg.sent.map((s) => s.text), ['take your pill']);
  assert.equal(outbox()[0].status, 'sent');
  assert.equal(lastMsg().delivery, 'sent', 'the log catches up');
});

test('a retry that fails again backs off further, and gives up as dead after the attempt limit', async () => {
  tg.failing = true;
  await channels.sendToPatient(linked(), { text: 'x' });
  let attempts = [outbox()[0].attempts];
  for (let i = 0; i < 12 && outbox()[0].status === 'pending'; i++) {
    clock.advance(60 * 60_000);
    await channels.flushOutbox();
    attempts.push(outbox()[0].attempts);
  }
  assert.equal(outbox()[0].status, 'dead');
  assert.equal(outbox()[0].attempts, 5, 'a routine message gets 5 tries');
  assert.equal(lastMsg().delivery, 'failed');
  assert.ok(store.listAudit('p1').some((a) => a.type === 'delivery_dead'));
  assert.deepEqual(attempts, [...attempts].sort((a, b) => a - b));
});

test('urgent messages get more tries than routine ones', async () => {
  tg.failing = true;
  await channels.sendToPatient(linked(), { text: '911', urgent: true });
  for (let i = 0; i < 20 && outbox()[0].status === 'pending'; i++) {
    clock.advance(60 * 60_000);
    await channels.flushOutbox();
  }
  assert.equal(outbox()[0].status, 'dead');
  assert.equal(outbox()[0].attempts, 12);
});

test('a patient with no linked channel is not queued forever: logged as unlinked, nothing to retry', async () => {
  store.updatePatient('p1', { chatId: null, phone: null });
  assert.equal(await channels.sendToPatient(store.getPatient('p1'), { text: 'hi' }), false);
  assert.equal(lastMsg().delivery, 'unlinked');
  assert.equal(outbox().length, 0);
});

test('if the preferred channel is down but another works, the message goes out on it and is not queued', async () => {
  tg.failing = true;
  assert.equal(await channels.sendToPatient(linked({ phone: '+15550001' }), { text: 'hi' }), true);
  assert.deepEqual(sms.sent.map((s) => s.text), ['hi']);
  assert.equal(outbox().length, 0);
});

test('retry uses the patient\'s channel at retry time (they linked a phone in between)', async () => {
  tg.failing = true;
  await channels.sendToPatient(linked(), { text: 'later' });
  store.updatePatient('p1', { chatId: null, phone: '+15550002', channel: 'sms' });
  clock.advance(3 * 60_000);
  await channels.flushOutbox();
  assert.deepEqual(sms.sent.map((s) => s.text), ['later']);
});

// ---- nurses ----
test('nurses with no channel configured: the alert is logged and an audit row says nobody was told', async () => {
  assert.equal(await channels.sendToNurses({ text: 'RED', patientId: 'p1' }), false);
  assert.equal(lastMsg().delivery, 'unlinked');
  assert.ok(store.listAudit('p1').some((a) => a.type === 'delivery_failed' && a.data.to === 'nurse'));
  assert.equal(outbox().length, 0);
});

test('NURSE_PHONE is a fallback when Telegram is down or NURSE_CHAT_ID is unset', async () => {
  process.env.NURSE_PHONE = '+15559998888';
  assert.equal(await channels.sendToNurses({ text: 'only sms configured', patientId: 'p1' }), true);
  process.env.NURSE_CHAT_ID = '-100123';
  tg.failing = true;
  assert.equal(await channels.sendToNurses({ text: 'telegram down', patientId: 'p1' }), true);
  assert.deepEqual(sms.sent.map((s) => s.text), ['only sms configured', 'telegram down']);
  assert.equal(sms.sent[0].address, '+15559998888');
});

test('a RED alert whose nurse message could not be delivered is flagged, and unflagged once a retry works', async () => {
  process.env.NURSE_CHAT_ID = '-100123';
  tg.failing = true;
  const alert = await escalation.escalate(store.getPatient('p1'), { tier: 'RED', flags: [{ code: 'chest_pain', tier: 'RED', text: 'Chest pain or pressure' }], priority: 200 });
  assert.equal(store.getAlert(alert.id).undelivered, true);
  tg.failing = false;
  clock.advance(3 * 60_000);
  await channels.flushOutbox();
  assert.equal(store.getAlert(alert.id).undelivered, false);
  assert.ok(tg.sent.some((s) => /RED/.test(s.text)));
  assert.ok(store.listAudit('p1').some((a) => a.type === 'delivery_recovered'));
});

test('with no nurse channel at all, alerts are NOT flagged undelivered (the dashboard is the channel)', async () => {
  const alert = await escalation.escalate(store.getPatient('p1'), { tier: 'RED', flags: [{ code: 'chest_pain', tier: 'RED', text: 'Chest pain' }], priority: 200 });
  assert.ok(!store.getAlert(alert.id).undelivered);
});

test('flushOutbox never throws and is safe to call concurrently', async () => {
  tg.failing = true;
  await channels.sendToPatient(linked(), { text: 'a' });
  tg.failing = false;
  clock.advance(3 * 60_000);
  const [x, y] = await Promise.all([channels.flushOutbox(), channels.flushOutbox()]);
  assert.equal(x, y, 'both callers share the one run');
  assert.equal(x.sent, 1, 'delivered once, not twice');
  assert.equal(tg.sent.length, 1);
});

test('old finished outbox rows are pruned', async () => {
  tg.failing = true;
  await channels.sendToPatient(linked(), { text: 'a' });
  tg.failing = false;
  clock.advance(3 * 60_000);
  await channels.flushOutbox();
  assert.equal(outbox().length, 1);
  clock.advance(3 * 24 * 60 * 60_000);
  store.prune();
  assert.equal(outbox().length, 0);
});
