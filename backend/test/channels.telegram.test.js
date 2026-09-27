// Telegram channel (K1): linking, commands, buttons, rendering. Fully offline.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-channels-tg-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, telegram, i18n, h;

before(async () => {
  store = await import('../src/store.js');
  telegram = await import('../src/channels/telegram.js');
  i18n = await import('../src/core/i18n.js');
  h = await import('./channels.harness.js');
});
beforeEach(() => store.reset());

const MARIA_CHAT = 4242;
const SOFIA_CHAT = 5151;

async function linkMaria() {
  const { bot, calls } = h.makeBot();
  await bot.handleUpdate(h.textUpdate(MARIA_CHAT, '/start GARCIA1'));
  return { bot, calls };
}

// ---------- /start ----------
test('/start with a valid code links the patient and welcomes her in Spanish', async () => {
  const { calls } = await linkMaria();
  assert.equal(store.findByChatId(MARIA_CHAT).patient.id, 'p1');
  assert.equal(h.lastSent(calls).text, i18n.t('es', 'welcome_patient', { name: 'Maria' }));
  assert.ok(store.listMessages('p1').some((m) => m.direction === 'out' && m.text === h.lastSent(calls).text), 'welcome logged');
});

test('/start with a code is case-insensitive', async () => {
  const { bot } = h.makeBot();
  await bot.handleUpdate(h.textUpdate(MARIA_CHAT, '/start garcia1'));
  assert.equal(store.findByChatId(MARIA_CHAT)?.patient.id, 'p1');
});

test('/start with an unknown code does not link and explains, in the app language', async () => {
  const { bot, calls } = h.makeBot();
  await bot.handleUpdate(h.textUpdate(777, '/start NOPE99'));
  assert.equal(store.findByChatId(777), null);
  assert.equal(h.lastSent(calls).text, i18n.t('en', 'unknown_code'));
  await bot.handleUpdate(h.textUpdate(778, '/start NOPE99', { languageCode: 'es-MX' }));
  assert.equal(h.lastSent(calls).text, i18n.t('es', 'unknown_code'));
});

test('/start with no code from an unlinked chat asks for a code', async () => {
  const { bot, calls } = h.makeBot();
  await bot.handleUpdate(h.textUpdate(777, '/start'));
  assert.equal(h.lastSent(calls).text, i18n.t('en', 'unknown_code'));
});

test('/start CG_ code links the caregiver, welcomed in the caregiver language', async () => {
  const { bot, calls } = h.makeBot();
  await bot.handleUpdate(h.textUpdate(SOFIA_CHAT, '/start CG_GARCIA1'));
  const link = store.findByChatId(SOFIA_CHAT);
  assert.equal(link.role, 'caregiver');
  assert.equal(link.patient.id, 'p1');
  assert.equal(store.getPatient('p1').chatId, null, 'patient chat untouched');
  assert.equal(h.lastSent(calls).text, i18n.t('en', 'welcome_caregiver', { name: 'Maria' }));
});

// ---------- text + buttons ----------
test('unlinked text asks for a code instead of reaching the core', async () => {
  const { bot, calls } = h.makeBot();
  await bot.handleUpdate(h.textUpdate(999, 'hola'));
  assert.equal(h.lastSent(calls).text, i18n.t('en', 'unknown_code'));
});

test('patient text round-trips through handleInbound and renders buttons', async () => {
  const { bot, calls } = await linkMaria();
  await bot.handleUpdate(h.textUpdate(MARIA_CHAT, 'hola'));
  const inbound = store.listMessages('p1').find((m) => m.direction === 'in');
  assert.equal(inbound.text, 'hola');
  assert.equal(inbound.channel, 'telegram');
  // "hola" starts a check-in: greeting then the weight question.
  assert.equal(h.lastSent(calls).text, i18n.t('es', 'ask_weight'));
  await bot.handleUpdate(h.textUpdate(MARIA_CHAT, '176'));
  const breath = h.lastSent(calls);
  assert.equal(breath.text, i18n.t('es', 'ask_breath'));
  assert.equal(breath.reply_markup.inline_keyboard[0][0].callback_data, 'ci:breath:normal');
});

test('a button tap answers the callback, locks the message, and advances the check-in', async () => {
  const { bot, calls } = await linkMaria();
  await bot.handleUpdate(h.textUpdate(MARIA_CHAT, '/checkin'));
  await bot.handleUpdate(h.textUpdate(MARIA_CHAT, '176'));
  const question = h.messageWithButton(calls, 'ci:breath:normal');
  await bot.handleUpdate(h.tapUpdate(MARIA_CHAT, 'ci:breath:normal', question));

  const methods = calls.map((c) => c.method);
  const tapAt = methods.lastIndexOf('answerCallbackQuery');
  assert.ok(tapAt >= 0);
  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.ok(methods.indexOf('editMessageText') > tapAt, 'edit comes after answering the callback');
  assert.equal(edit.payload.text, `${question.text}\n\n→ ${i18n.t('es', 'breath_normal')}`);
  assert.deepEqual(edit.payload.reply_markup.inline_keyboard, []);
  assert.equal(store.getPatient('p1').checkin.answers.breath, 'normal');
});

test('a tap from an unlinked chat is answered but ignored', async () => {
  const { bot, calls } = h.makeBot();
  await bot.handleUpdate(h.tapUpdate(31337, 'ci:breath:normal', { text: 'x' }));
  assert.deepEqual(calls.map((c) => c.method), ['answerCallbackQuery']);
});

test('a failed edit (message too old) does not break the tap', async () => {
  const { bot, calls } = h.makeBot({
    results: {
      editMessageText: () => {
        throw new Error('message is not modified');
      },
    },
  });
  await bot.handleUpdate(h.textUpdate(MARIA_CHAT, '/start GARCIA1'));
  await bot.handleUpdate(h.tapUpdate(MARIA_CHAT, 'cmd:checkin', { text: 'x', reply_markup: { inline_keyboard: [[{ text: 'Go', callback_data: 'cmd:checkin' }]] } }));
  assert.equal(h.lastSent(calls).text, i18n.t('es', 'ask_weight'));
});

test('caregiver text and taps reach handleInbound as role caregiver with the patient id', async () => {
  const { bot, calls } = h.makeBot();
  await bot.handleUpdate(h.textUpdate(SOFIA_CHAT, '/start CG_GARCIA1'));
  await bot.handleUpdate(h.textUpdate(SOFIA_CHAT, 'Mom seems tired today'));
  const inbound = store.listMessages('p1').filter((m) => m.direction === 'in');
  assert.equal(inbound.at(-1).from, 'caregiver');
  assert.equal(inbound.at(-1).text, 'Mom seems tired today');
  assert.match(h.lastSent(calls).text, /caregiver/i);
  await bot.handleUpdate(h.tapUpdate(SOFIA_CHAT, 'ci:breath:normal', { text: 'q' }));
  assert.equal(store.listMessages('p1').filter((m) => m.direction === 'in').at(-1).from, 'caregiver');
  assert.equal(store.getPatient('p1').checkin?.answers?.breath, undefined, "caregiver taps don't answer the patient's check-in");
});

// ---------- commands ----------
test('/checkin starts a check-in and logs the prompts', async () => {
  const { bot, calls } = await linkMaria();
  await bot.handleUpdate(h.textUpdate(MARIA_CHAT, '/checkin'));
  const texts = h.sent(calls).map((p) => p.text);
  assert.ok(texts.includes(i18n.t('es', 'greeting', { name: 'Maria' })));
  assert.equal(texts.at(-1), i18n.t('es', 'ask_weight'));
  assert.equal(store.getPatient('p1').checkin.state, 'weight');
  assert.ok(store.listMessages('p1').some((m) => m.text === i18n.t('es', 'ask_weight')));
});

test('/help replies in the patient language', async () => {
  const { bot, calls } = await linkMaria();
  await bot.handleUpdate(h.textUpdate(MARIA_CHAT, '/help'));
  assert.equal(h.lastSent(calls).text, i18n.t('es', 'help'));
});

test('commands from an unlinked chat ask for a code', async () => {
  const { bot, calls } = h.makeBot();
  for (const cmd of ['/help', '/checkin', '/language', '/voice', '/meds']) {
    await bot.handleUpdate(h.textUpdate(1234, cmd));
    assert.equal(h.lastSent(calls).text, i18n.t('en', 'unknown_code'), cmd);
  }
});

test('/voice toggles voiceMode and confirms', async () => {
  const { bot, calls } = await linkMaria();
  await bot.handleUpdate(h.textUpdate(MARIA_CHAT, '/voice'));
  assert.equal(store.getPatient('p1').voiceMode, true);
  assert.equal(h.lastSent(calls).text, i18n.t('es', 'voice_on'));
  await bot.handleUpdate(h.textUpdate(MARIA_CHAT, '/voice'));
  assert.equal(store.getPatient('p1').voiceMode, false);
  assert.equal(h.lastSent(calls).text, i18n.t('es', 'voice_off'));
});

test('/meds lists every medicine', async () => {
  const { bot, calls } = await linkMaria();
  await bot.handleUpdate(h.textUpdate(MARIA_CHAT, '/meds'));
  const text = h.lastSent(calls).text;
  for (const m of store.getPatient('p1').meds) assert.ok(text.includes(m.name), m.name);
});

test('/language shows every supported language, and a pick switches the next check-in', async () => {
  const { bot, calls } = await linkMaria();
  await bot.handleUpdate(h.textUpdate(MARIA_CHAT, '/language'));
  const picker = h.lastSent(calls);
  assert.equal(picker.text, i18n.t('es', 'language_prompt'));
  const codes = picker.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  const { languages } = await import('../src/core/enroll.js');
  assert.deepEqual(codes, languages().map((l) => `lang:${l.code}`));

  await bot.handleUpdate(h.tapUpdate(MARIA_CHAT, 'lang:en', picker));
  assert.equal(store.getPatient('p1').language, 'en');
  assert.equal(h.lastSent(calls).text, i18n.t('en', 'language_set', { language: 'English' }));

  await bot.handleUpdate(h.textUpdate(MARIA_CHAT, '/checkin'));
  assert.equal(h.lastSent(calls).text, i18n.t('en', 'ask_weight'));
});

test('a caregiver language pick changes the caregiver, not the patient', async () => {
  const { bot } = h.makeBot();
  await bot.handleUpdate(h.textUpdate(SOFIA_CHAT, '/start CG_GARCIA1'));
  await bot.handleUpdate(h.tapUpdate(SOFIA_CHAT, 'lang:es', { text: 'q' }));
  assert.equal(store.getPatient('p1').caregiver.language, 'es');
  assert.equal(store.getPatient('p1').language, 'es');
  await bot.handleUpdate(h.tapUpdate(SOFIA_CHAT, 'lang:vi', { text: 'q' }));
  assert.equal(store.getPatient('p1').caregiver.language, 'vi');
  assert.equal(store.getPatient('p1').language, 'es');
});

test('an unsupported lang: code is passed to the core, not applied', async () => {
  const { bot } = await linkMaria();
  await bot.handleUpdate(h.tapUpdate(MARIA_CHAT, 'lang:xx', { text: 'q' }));
  assert.equal(store.getPatient('p1').language, 'es');
});

// ---------- rendering ----------
test('urgent replies are bold HTML with a 🚨 prefix and get pinned', async () => {
  const { bot, calls } = h.makeBot();
  await telegram.renderReply(bot.api, 1, { text: 'Call 911 now', urgent: true });
  const msg = h.lastSent(calls);
  assert.equal(msg.parse_mode, 'HTML');
  assert.equal(msg.text, '<b>🚨 Call 911 now</b>');
  assert.ok(calls.some((c) => c.method === 'pinChatMessage'));
});

test('urgent text that already starts with 🚨 is not double-prefixed', async () => {
  const { bot, calls } = h.makeBot();
  await telegram.renderReply(bot.api, 1, { text: '🚨 CALL 911', urgent: true });
  assert.equal(h.lastSent(calls).text, '<b>🚨 CALL 911</b>');
});

test('urgent rendering escapes HTML from user-provided text', async () => {
  const { bot, calls } = h.makeBot();
  await telegram.renderReply(bot.api, 1, { text: 'I heard "<b>chest</b> & <i>pain</i>"', urgent: true });
  assert.equal(h.lastSent(calls).text, '<b>🚨 I heard "&lt;b&gt;chest&lt;/b&gt; &amp; &lt;i&gt;pain&lt;/i&gt;"</b>');
});

test('a failed pin does not fail the urgent send', async () => {
  const { bot, calls } = h.makeBot({
    results: {
      pinChatMessage: () => {
        throw new Error('not enough rights');
      },
    },
  });
  const res = await telegram.renderReply(bot.api, 1, { text: 'x', urgent: true });
  assert.ok(res.message_id);
  assert.equal(h.sent(calls).length, 1);
});

test('non-urgent replies are plain text (no parse_mode, no escaping needed)', async () => {
  const { bot, calls } = h.makeBot();
  await telegram.renderReply(bot.api, 1, { text: 'a < b', buttons: [[{ label: 'A', data: 'x:a' }]] });
  const msg = h.lastSent(calls);
  assert.equal(msg.parse_mode, undefined);
  assert.equal(msg.text, 'a < b');
  assert.equal(msg.reply_markup.inline_keyboard[0][0].callback_data, 'x:a');
});

test('sendToChat uses the active bot and throws when none is running', async () => {
  telegram.useBot(null);
  await assert.rejects(() => telegram.sendToChat(1, { text: 'hi' }));
  const { bot, calls } = h.makeBot();
  telegram.useBot(bot);
  await telegram.sendToChat(1, { text: 'hi' });
  assert.equal(h.lastSent(calls).text, 'hi');
  telegram.useBot(null);
});

// ---------- groups ----------
test('group chats are logged once and never treated as patients', async () => {
  const { bot, calls } = h.makeBot();
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    await bot.handleUpdate(h.textUpdate(-100123, 'hello team', { chatType: 'supergroup' }));
    await bot.handleUpdate(h.textUpdate(-100123, '/start GARCIA1', { chatType: 'supergroup' }));
  } finally {
    console.log = orig;
  }
  assert.equal(logs.filter((l) => l.includes('-100123')).length, 1);
  assert.equal(calls.length, 0);
  assert.equal(store.getPatient('p1').chatId, null);
});
