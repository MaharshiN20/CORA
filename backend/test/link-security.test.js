// Phase 1: care codes can't be used to take over a patient's chat or phone.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-linksec-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TWILIO_AUTH_TOKEN;

let store, h, enroll, security, i18n, server, base;
before(async () => {
  store = await import('../src/store.js');
  h = await import('./channels.harness.js');
  enroll = await import('../src/core/enroll.js');
  security = await import('../src/security.js');
  i18n = await import('../src/core/i18n.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());
beforeEach(() => {
  store.reset();
  security.resetJoinThrottle();
  process.env.ALLOW_RELINK = '0'; // production-like: a linked code is locked until a nurse unlinks it
});

const sentTexts = (calls) => calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text);
const sms = (from, body) =>
  fetch(`${base}/webhooks/twilio/sms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: from, Body: body }),
  }).then((r) => r.text());

test('codes for new patients are random (no Math.random, no look-alike characters)', () => {
  const codes = new Set();
  for (let i = 0; i < 200; i++) {
    const p = enroll.createPatient({ name: `Test Person${i}`, source: 'manual' });
    assert.match(p.linkCode, /^[A-Z]+[A-HJ-NP-Z2-9]{6}$/);
    codes.add(p.linkCode);
  }
  assert.equal(codes.size, 200);
});

test('Telegram: a second chat cannot take over an already-linked patient', async () => {
  const { bot, calls } = h.makeBot();
  await bot.handleUpdate(h.textUpdate(7001, '/start GARCIA1'));
  assert.equal(store.getPatient('p1').chatId, 7001);
  calls.length = 0;
  await bot.handleUpdate(h.textUpdate(7002, '/start GARCIA1'));
  assert.equal(store.getPatient('p1').chatId, 7001, 'original link untouched');
  assert.equal(store.findByChatId(7002), null);
  assert.ok(sentTexts(calls).some((x) => x === i18n.t('en', 'code_in_use')), 'attacker is told the code is in use');
  assert.ok(store.listAudit('p1').some((a) => a.type === 'link_refused'));
});

test('Telegram: the same chat re-sending its own code is fine; caregiver slot is separate', async () => {
  const { bot } = h.makeBot();
  await bot.handleUpdate(h.textUpdate(7011, '/start GARCIA1'));
  await bot.handleUpdate(h.textUpdate(7011, '/start GARCIA1'));
  assert.equal(store.getPatient('p1').chatId, 7011);
  await bot.handleUpdate(h.textUpdate(7012, '/start CG_GARCIA1'));
  assert.equal(store.getPatient('p1').caregiver.chatId, 7012);
  await bot.handleUpdate(h.textUpdate(7013, '/start CG_GARCIA1'));
  assert.equal(store.getPatient('p1').caregiver.chatId, 7012, 'caregiver slot is locked too');
});

test('Telegram: judge DEMO codes always work (they make a fresh clone)', async () => {
  const { bot } = h.makeBot();
  await bot.handleUpdate(h.textUpdate(7021, '/start DEMO'));
  await bot.handleUpdate(h.textUpdate(7022, '/start DEMO'));
  assert.equal(store.findByChatId(7021).patient.source, 'demo');
  assert.equal(store.findByChatId(7022).patient.source, 'demo');
});

test('Telegram: guessing codes is throttled per chat', async () => {
  const { bot, calls } = h.makeBot();
  for (let i = 0; i < 5; i++) await bot.handleUpdate(h.textUpdate(7031, `/start NOPE${i}`));
  calls.length = 0;
  await bot.handleUpdate(h.textUpdate(7031, '/start JOHNSON1')); // a real, unlinked code
  assert.equal(store.findByChatId(7031), null, 'blocked after 5 misses');
  // other chats are unaffected
  await bot.handleUpdate(h.textUpdate(7032, '/start JOHNSON1'));
  assert.equal(store.findByChatId(7032).patient.linkCode, 'JOHNSON1');
});

test('SMS: JOIN from a second phone is refused; the first phone keeps the link', async () => {
  await sms('+15550000001', 'JOIN GARCIA1');
  assert.equal(store.getPatient('p1').phone, '+15550000001');
  const reply = await sms('+15550000002', 'JOIN GARCIA1');
  assert.equal(store.getPatient('p1').phone, '+15550000001');
  assert.match(reply, /already linked/i);
  assert.ok(store.listAudit('p1').some((a) => a.type === 'link_refused'));
});

test('SMS: the same phone can re-JOIN; guessing is throttled', async () => {
  await sms('+15550000011', 'JOIN GARCIA1');
  await sms('+15550000011', 'JOIN GARCIA1');
  assert.equal(store.getPatient('p1').phone, '+15550000011');
  for (let i = 0; i < 5; i++) await sms('+15550000012', `JOIN WRONG${i}`);
  await sms('+15550000012', 'JOIN JOHNSON1');
  assert.notEqual(store.getPatient('p2').phone, '+15550000012', 'blocked after 5 misses');
});

test('nurses can release a link: POST /api/patients/:id/unlink, then a new chat can join', async () => {
  const { bot } = h.makeBot();
  await bot.handleUpdate(h.textUpdate(7041, '/start GARCIA1'));
  const res = await fetch(`${base}/api/patients/p1/unlink`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'patient' }) });
  assert.equal(res.status, 200);
  assert.equal(store.getPatient('p1').chatId, null);
  await bot.handleUpdate(h.textUpdate(7042, '/start GARCIA1'));
  assert.equal(store.getPatient('p1').chatId, 7042);
  assert.equal((await fetch(`${base}/api/patients/nope/unlink`, { method: 'POST' })).status, 404);
});

test('ALLOW_RELINK unset keeps dev/demo friendly (re-linking works outside production)', async () => {
  delete process.env.ALLOW_RELINK;
  const { bot } = h.makeBot();
  await bot.handleUpdate(h.textUpdate(7051, '/start GARCIA1'));
  await bot.handleUpdate(h.textUpdate(7052, '/start GARCIA1'));
  assert.equal(store.getPatient('p1').chatId, 7052);
});
