// Things the bot cannot read: a video note (Telegram's mic button turns into a camera with one
// tap), a sticker, a location, a PDF, a voice note nobody could transcribe. They used to get no
// answer at all, left nothing for the nurse to see, and during a RED lock did not repeat "call 911".
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-channels-unreadable-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.GROQ_API_KEY;

let store, telegram, i18n, h;

before(async () => {
  store = await import('../src/store.js');
  telegram = await import('../src/channels/telegram.js');
  i18n = await import('../src/core/i18n.js');
  h = await import('./channels.harness.js');
});

const realFetch = globalThis.fetch;
beforeEach(() => {
  store.reset();
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://api.telegram.org/file/bottest:token/')) return new Response(Buffer.from('OggS'));
    throw new Error(`unexpected fetch ${url}`);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  telegram.useBot(null);
});

const CHAT = 4242;
let n = 80_000;
const update = (chatId, content) => ({
  update_id: ++n,
  message: { message_id: ++n, date: 0, chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false, first_name: 'Maria' }, ...content },
});
const videoNote = { video_note: { file_id: 'vn', file_unique_id: 'vn', length: 240, duration: 4 } };
const sticker = { sticker: { file_id: 'st', file_unique_id: 'st', type: 'regular', width: 512, height: 512, is_animated: false, is_video: false } };
const location = { location: { latitude: 33.77, longitude: -84.39 } };
const pdf = { document: { file_id: 'd', file_unique_id: 'd', file_name: 'discharge.pdf', mime_type: 'application/pdf', file_size: 9000 } };
const voice = { voice: { file_id: 'v1', file_unique_id: 'u1', duration: 3, mime_type: 'audio/ogg', file_size: 3000 } };

async function linkedMaria() {
  const { bot, calls } = h.makeBot({ results: { getFile: { file_id: 'v1', file_unique_id: 'u1', file_size: 3000, file_path: 'voice/file_1.oga' } } });
  await bot.handleUpdate(h.textUpdate(CHAT, '/start GARCIA1'));
  return { bot, calls };
}
const inbound = () => store.listMessages('p1').filter((m) => m.direction === 'in').map((m) => m.text);
const reds = () => store.listAlerts('p1').filter((a) => a.tier === 'RED');

test('a video note in the middle of a check-in gets an answer and the question again', async () => {
  const { bot, calls } = await linkedMaria();
  await bot.handleUpdate(h.textUpdate(CHAT, '/checkin'));
  const before = h.sent(calls).length;
  await bot.handleUpdate(update(CHAT, videoNote));
  assert.equal(h.sent(calls).length, before + 1, 'one reply');
  assert.ok(h.lastSent(calls).text.includes(i18n.t('es', 'ask_redflags')), 'the question is asked again');
  assert.equal(inbound().at(-1), '[video note]', 'the nurse sees that something arrived');
  assert.equal(store.getPatient('p1').checkin.state, 'redflags');
});

test('a sticker, a location and a PDF each get an answer when no check-in is running', async () => {
  const { bot, calls } = await linkedMaria();
  for (const [content, shown] of [[sticker, '[sticker]'], [location, '[location]'], [pdf, '[file]']]) {
    const before = h.sent(calls).length;
    await bot.handleUpdate(update(CHAT, content));
    assert.equal(h.sent(calls).length, before + 1, `${shown} got a reply`);
    assert.equal(inbound().at(-1), shown);
  }
});

test('during a RED lock anything unreadable repeats "call 911" and lands on the RED alert', async () => {
  const { bot, calls } = await linkedMaria();
  await bot.handleUpdate(h.textUpdate(CHAT, 'me duele mucho el pecho'));
  assert.equal(reds().length, 1);
  for (const content of [videoNote, voice]) {
    await bot.handleUpdate(update(CHAT, content));
    assert.match(h.lastSent(calls).text, /911/);
    assert.match(h.lastSent(calls).text, /^<b>🚨/);
  }
  assert.equal(reds().length, 1, 'still one incident');
  assert.equal(reds()[0].reasons.filter((r) => /messaged again/.test(r)).length, 2);
});

test('the words under a video are read, like the words under a photo', async () => {
  const { bot } = await linkedMaria();
  await bot.handleUpdate(update(CHAT, { video: { file_id: 'vid', file_unique_id: 'vid', width: 640, height: 480, duration: 5 }, caption: 'me duele mucho el pecho' }));
  assert.equal(reds().length, 1);
});

test('a voice note that could not be transcribed is logged, answered, and carries the 911 line', async () => {
  const { bot, calls } = await linkedMaria();
  await bot.handleUpdate(update(CHAT, voice));
  const reply = h.lastSent(calls).text;
  assert.ok(reply.startsWith(i18n.t('es', 'voice_unavailable')));
  assert.ok(reply.includes(i18n.t('es', 'safety_net_911')), 'we could not hear it, so say what to do in an emergency');
  assert.equal(inbound().at(-1), '[voice note]');
  const out = store.listMessages('p1').filter((m) => m.direction === 'out').at(-1);
  assert.equal(out.text, reply, 'the nurse sees what the patient was told');
  assert.ok(out.textEn.includes(i18n.t('en', 'safety_net_911')));
});

test('Telegram service messages (a pin, a new chat title) are still ignored', async () => {
  const { bot, calls } = await linkedMaria();
  const before = calls.length;
  await bot.handleUpdate(update(CHAT, { pinned_message: { message_id: 1, date: 0, chat: { id: CHAT, type: 'private' }, text: 'x' } }));
  assert.equal(calls.length, before);
});

test('an unlinked chat that sends a sticker is asked for its code', async () => {
  const { bot, calls } = h.makeBot();
  await bot.handleUpdate(update(999, sticker));
  assert.equal(h.lastSent(calls).text, i18n.t('en', 'unknown_code'));
});
