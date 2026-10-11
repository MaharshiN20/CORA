// Edited Telegram messages. A patient who fixes a message ("estoy bien" -> "me duele el pecho")
// has said something new; the bot used to ignore every edit, in both polling and webhook mode.
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-channels-edits-${process.pid}.json`);
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
afterEach(() => telegram.useBot(null));

const CHAT = 4242;
let n = 50_000;

// What Telegram sends when the user edits a message they already sent.
function editUpdate(original, text) {
  return { update_id: ++n, edited_message: { ...original.message, edit_date: 1, text } };
}

async function linkedMaria() {
  const { bot, calls } = h.makeBot();
  await bot.handleUpdate(h.textUpdate(CHAT, '/start GARCIA1'));
  return { bot, calls };
}

const inbound = () => store.listMessages('p1').filter((m) => m.direction === 'in').map((m) => m.text);
const reds = () => store.listAlerts('p1').filter((a) => a.tier === 'RED');

test('an emergency typed as an edit of an earlier message gets the 911 reply and a RED alert', async () => {
  const { bot, calls } = await linkedMaria();
  const first = h.textUpdate(CHAT, 'gracias');
  await bot.handleUpdate(first);
  assert.equal(reds().length, 0);

  await bot.handleUpdate(editUpdate(first, 'me duele mucho el pecho'));
  assert.equal(reds().length, 1, 'the edit was read');
  assert.match(h.lastSent(calls).text, /^<b>🚨/);
  assert.deepEqual(inbound().slice(-1), ['me duele mucho el pecho'], 'the nurse sees the new words');
});

test('an edited answer inside a check-in is read as the new answer', async () => {
  const { bot } = await linkedMaria();
  await bot.handleUpdate(h.textUpdate(CHAT, '/checkin'));
  const answer = h.textUpdate(CHAT, 'mmm');
  await bot.handleUpdate(answer);
  assert.equal(store.getPatient('p1').checkin.state, 'redflags', 'still on the first question');
  await bot.handleUpdate(editUpdate(answer, 'no'));
  assert.equal(store.getPatient('p1').checkin.state, 'weight');
});

test('an edit from a chat that is not linked asks for the code, like any other message', async () => {
  const { bot, calls } = h.makeBot();
  await bot.handleUpdate(editUpdate(h.textUpdate(999, 'hello'), 'hello there'));
  assert.equal(h.lastSent(calls).text, i18n.t('en', 'unknown_code'));
});

test('an edited command is not run a second time', async () => {
  const { bot, calls } = await linkedMaria();
  const cmd = h.textUpdate(CHAT, '/voice');
  await bot.handleUpdate(cmd);
  assert.equal(store.getPatient('p1').voiceMode, true);
  const before = calls.length;
  await bot.handleUpdate({ update_id: ++n, edited_message: { ...cmd.message, edit_date: 1 } });
  assert.equal(store.getPatient('p1').voiceMode, true, 'the toggle did not flip back');
  assert.equal(calls.length, before);
});

test('webhook mode asks Telegram to deliver edited messages too', async () => {
  const { bot, calls } = h.makeBot();
  telegram.useBot(bot);
  const saved = [console.log, console.warn];
  console.log = console.warn = () => {};
  try {
    await telegram.launch(bot, telegram.webhookConfig({ TELEGRAM_WEBHOOK_URL: 'https://hb.example.org', TELEGRAM_WEBHOOK_SECRET: 'S3cret' }));
  } finally {
    [console.log, console.warn] = saved;
  }
  assert.ok(calls.find((c) => c.method === 'setWebhook').payload.allowed_updates.includes('edited_message'));
});
