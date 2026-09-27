// Judge mode (K2): /start DEMO[_LANG], /demo in the nurse group, /api/join links. Fully offline.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-channels-judge-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;
process.env.TELEGRAM_BOT_USERNAME = 'hb_test_bot';
const NURSES = -100555;
process.env.NURSE_CHAT_ID = String(NURSES);

let store, i18n, enroll, h, server, base;

before(async () => {
  store = await import('../src/store.js');
  i18n = await import('../src/core/i18n.js');
  enroll = await import('../src/core/enroll.js');
  h = await import('./channels.harness.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());
beforeEach(() => store.reset());

const demoPatients = () => store.listPatients().filter((p) => p.source === 'demo');

// Answers that make Maria's clone a clear YELLOW (weight up, worse swelling) without any RED flag.
const JUDGE_PICKS = ['ci:breath:exertion', 'ci:orth:no', 'ci:swell:worse', 'ci:rf:none', 'ci:diu:yes', 'ci:spo2:none'];

test('a judge runs the whole check-in by taps + free text and a YELLOW alert lands on the worklist', async () => {
  const JUDGE = 90001;
  const { bot, calls } = h.makeBot();
  await bot.handleUpdate(h.textUpdate(JUDGE, '/start DEMO_ES'));

  const [patient] = demoPatients();
  assert.ok(patient, 'demo patient enrolled');
  assert.equal(patient.chatId, JUDGE);
  assert.equal(patient.language, 'es');
  const texts = h.sent(calls).map((p) => p.text);
  assert.equal(texts[0], i18n.t('es', 'welcome_patient', { name: patient.name.split(' ')[0] }));
  assert.equal(texts.at(-1), i18n.t('es', 'ask_redflags'), 'check-in starts immediately, emergencies first');

  await bot.handleUpdate(h.tapUpdate(JUDGE, 'ci:rf:none', h.lastSent(calls)));
  await bot.handleUpdate(h.textUpdate(JUDGE, '179'));
  for (let i = 0; i < 10; i++) {
    const last = h.lastSent(calls);
    const options = last.reply_markup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];
    const pick = JUDGE_PICKS.find((d) => options.includes(d));
    if (!pick) break;
    await bot.handleUpdate(h.tapUpdate(JUDGE, pick, last));
  }

  const alerts = store.listAlerts().filter((a) => a.patientId === patient.id && a.kind === 'triage');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].tier, 'YELLOW');
  assert.ok(h.sent(calls).some((p) => p.text === i18n.t('es', 'thanks_yellow', { name: patient.name.split(' ')[0] })));
  assert.ok(calls.filter((c) => c.method === 'editMessageText').length >= 4, 'every tapped question was locked');
});

test('/start DEMO_<LANG> enrolls a demo patient in every supported language', async () => {
  const { bot, calls } = h.makeBot();
  let chat = 91000;
  for (const { code, native } of enroll.languages()) {
    await bot.handleUpdate(h.textUpdate(++chat, `/start DEMO_${code.toUpperCase()}`));
    const link = store.findByChatId(chat);
    assert.equal(link?.role, 'patient', code);
    assert.equal(link.patient.language, code);
    assert.equal(link.patient.source, 'demo');
    assert.match(link.patient.linkCode, /^DEMO[A-Z0-9]{5}$/);
    // No LLM in tests: non-native languages use their generated template translation
    // (src/core/i18n-generated, P2-11) when one exists, otherwise the English template.
    const expected = native ? i18n.t(code, 'ask_redflags') : await i18n.localize(code, i18n.t('en', 'ask_redflags'));
    assert.equal(h.lastSent(calls).text, expected, code);
  }
  assert.equal(demoPatients().length, enroll.languages().length);
});

test('/start DEMO with no language uses the Telegram app language, else English', async () => {
  const { bot } = h.makeBot();
  await bot.handleUpdate(h.textUpdate(92001, '/start DEMO', { languageCode: 'es' }));
  assert.equal(store.findByChatId(92001).patient.language, 'es');
  await bot.handleUpdate(h.textUpdate(92002, '/start DEMO'));
  assert.equal(store.findByChatId(92002).patient.language, 'en');
});

test('an unknown DEMO language falls back to English', async () => {
  const { bot } = h.makeBot();
  await bot.handleUpdate(h.textUpdate(92003, '/start DEMO_XX'));
  assert.equal(store.findByChatId(92003).patient.language, 'en');
});

test('an already-linked chat sending /start DEMO gets a fresh demo patient and loses the old link', async () => {
  const CHAT = 93001;
  const { bot } = h.makeBot();
  await bot.handleUpdate(h.textUpdate(CHAT, '/start DEMO_EN'));
  const first = store.findByChatId(CHAT).patient;
  await bot.handleUpdate(h.textUpdate(CHAT, '/start DEMO_ES'));
  const second = store.findByChatId(CHAT).patient;
  assert.notEqual(second.id, first.id);
  assert.equal(second.language, 'es');
  assert.equal(store.getPatient(first.id).chatId, null);
  assert.equal(second.checkin.state, 'redflags', 'fresh patient is mid check-in');
});

test('a seeded patient chat that switches to DEMO no longer receives as the seeded patient', async () => {
  const CHAT = 93002;
  const { bot } = h.makeBot();
  await bot.handleUpdate(h.textUpdate(CHAT, '/start GARCIA1'));
  await bot.handleUpdate(h.textUpdate(CHAT, '/start DEMO'));
  assert.equal(store.getPatient('p1').chatId, null);
  assert.equal(store.findByChatId(CHAT).patient.source, 'demo');
});

test('re-linking a chat with a regular code moves it (caregiver -> patient)', async () => {
  const CHAT = 93003;
  const { bot } = h.makeBot();
  await bot.handleUpdate(h.textUpdate(CHAT, '/start CG_GARCIA1'));
  await bot.handleUpdate(h.textUpdate(CHAT, '/start JOHNSON1'));
  assert.equal(store.getPatient('p1').caregiver.chatId, null);
  assert.equal(store.findByChatId(CHAT).patient.linkCode, 'JOHNSON1');
});

test('an invalid code on a linked chat keeps the existing link', async () => {
  const CHAT = 93004;
  const { bot } = h.makeBot();
  await bot.handleUpdate(h.textUpdate(CHAT, '/start GARCIA1'));
  await bot.handleUpdate(h.textUpdate(CHAT, '/start NOPE'));
  assert.equal(store.getPatient('p1').chatId, CHAT);
});

// ---------- /demo in the nurse group ----------
const groupCmd = (chatId, text) => h.textUpdate(chatId, text, { chatType: 'supergroup' });

test('/demo in the nurse group replies with a join link per language', async () => {
  const { bot, calls } = h.makeBot();
  const log = console.log;
  console.log = () => {};
  try {
    await bot.handleUpdate(groupCmd(NURSES, '/demo'));
  } finally {
    console.log = log;
  }
  const text = h.lastSent(calls).text;
  for (const l of enroll.languages()) assert.ok(text.includes(`https://t.me/hb_test_bot?start=DEMO_${l.code.toUpperCase()}`), l.code);
  assert.equal(demoPatients().length, 0, 'the group itself is never enrolled');
});

test('/demo in some other group is ignored', async () => {
  const { bot, calls } = h.makeBot();
  const log = console.log;
  console.log = () => {};
  try {
    await bot.handleUpdate(groupCmd(-100999, '/demo'));
  } finally {
    console.log = log;
  }
  assert.equal(calls.length, 0);
});

// ---------- /api/join ----------
test('GET /api/join returns a DEMO deep link for every language', async () => {
  const body = await (await fetch(`${base}/api/join`)).json();
  assert.equal(body.bot, 'hb_test_bot');
  assert.deepEqual(body.links.map((l) => l.language), enroll.languages().map((l) => l.code));
  for (const l of body.links) assert.equal(l.url, `https://t.me/hb_test_bot?start=DEMO_${l.language.toUpperCase()}`);
});

test('GET /api/join?format=text returns printable plain-text links', async () => {
  const res = await fetch(`${base}/api/join?format=text`);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  const lines = (await res.text()).split('\n');
  assert.equal(lines.length, enroll.languages().length);
  assert.equal(lines[1], 'Español (Spanish): https://t.me/hb_test_bot?start=DEMO_ES');
});

test('join links degrade to null / a hint when the bot username is not set', async () => {
  const saved = process.env.TELEGRAM_BOT_USERNAME;
  delete process.env.TELEGRAM_BOT_USERNAME;
  try {
    const body = await (await fetch(`${base}/api/join`)).json();
    assert.equal(body.bot, null);
    assert.ok(body.links.every((l) => l.url === null));
    assert.match(await (await fetch(`${base}/api/join?format=text`)).text(), /TELEGRAM_BOT_USERNAME/);
  } finally {
    process.env.TELEGRAM_BOT_USERNAME = saved;
  }
});

test('a leading @ in TELEGRAM_BOT_USERNAME is tolerated', async () => {
  const saved = process.env.TELEGRAM_BOT_USERNAME;
  process.env.TELEGRAM_BOT_USERNAME = '@hb_test_bot';
  try {
    const body = await (await fetch(`${base}/api/join`)).json();
    assert.equal(body.links[0].url, 'https://t.me/hb_test_bot?start=DEMO_EN');
  } finally {
    process.env.TELEGRAM_BOT_USERNAME = saved;
  }
});
