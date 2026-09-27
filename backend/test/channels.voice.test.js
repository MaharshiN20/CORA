// Voice-first mode in the Telegram channel (K3). Telegram API calls are recorded by the
// harness; file downloads, Groq and Google TTS are served by a mocked fetch.
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-channels-voice-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, telegram, channels, i18n, h;

before(async () => {
  store = await import('../src/store.js');
  telegram = await import('../src/channels/telegram.js');
  channels = await import('../src/channels/index.js');
  i18n = await import('../src/core/i18n.js');
  h = await import('./channels.harness.js');
});

const realFetch = globalThis.fetch;
let fetches;
let groqText;

beforeEach(() => {
  store.reset();
  fetches = [];
  groqText = '176';
  process.env.GROQ_API_KEY = 'gsk_test';
  globalThis.fetch = async (url) => {
    url = String(url);
    fetches.push(url);
    if (url.startsWith('https://api.telegram.org/file/bottest:token/')) return new Response(Buffer.from('OggS'));
    if (url.startsWith('https://api.groq.com/')) return Response.json({ text: groqText });
    if (url.includes('translate.google.com')) return new Response(Buffer.from('ID3 mp3'));
    throw new Error(`unexpected fetch ${url}`);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GROQ_API_KEY;
  telegram.useBot(null);
});

const CHAT = 4242;
const getFileResult = (size = 3000) => ({ file_id: 'v1', file_unique_id: 'u1', file_size: size, file_path: 'voice/file_1.oga' });

function voiceUpdate(chatId, { size = 3000 } = {}) {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: Math.floor(Math.random() * 1e6),
      date: 0,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, is_bot: false, first_name: 'Maria' },
      voice: { file_id: 'v1', file_unique_id: 'u1', duration: 3, mime_type: 'audio/ogg', file_size: size },
    },
  };
}

async function mariaMidCheckin(results = {}) {
  const { bot, calls } = h.makeBot({ results: { getFile: getFileResult(), ...results } });
  await bot.handleUpdate(h.textUpdate(CHAT, '/start GARCIA1'));
  await bot.handleUpdate(h.textUpdate(CHAT, '/checkin'));
  await bot.handleUpdate(h.textUpdate(CHAT, 'no')); // red-flag screen first; the voice note answers the weight
  return { bot, calls };
}

test('a voice note is transcribed, echoed back, and answers the check-in', async () => {
  const { bot, calls } = await mariaMidCheckin();
  await bot.handleUpdate(voiceUpdate(CHAT));

  assert.ok(fetches.some((u) => u === 'https://api.telegram.org/file/bottest:token/voice/file_1.oga'), 'downloaded from Telegram');
  assert.ok(fetches.some((u) => u.startsWith('https://api.groq.com/')), 'sent to Whisper');
  const texts = h.sent(calls).map((p) => p.text);
  assert.ok(texts.includes(i18n.t('es', 'heard', { text: '176' })));
  assert.equal(texts.at(-1), i18n.t('es', 'ask_breath'), 'check-in moved on to breathing');
  assert.equal(store.getPatient('p1').checkin.answers.weightLb, 176);
  const inbound = store.listMessages('p1').filter((m) => m.direction === 'in');
  assert.equal(inbound.at(-1).text, '176');
});

test('no GROQ key: the patient is asked to type, in her language, and nothing reaches the core', async () => {
  delete process.env.GROQ_API_KEY;
  const { bot, calls } = await mariaMidCheckin();
  const inbound = () => store.listMessages('p1').filter((m) => m.direction === 'in').length;
  const before = inbound();
  await bot.handleUpdate(voiceUpdate(CHAT));
  assert.equal(h.lastSent(calls).text, i18n.t('es', 'voice_unavailable'));
  assert.equal(inbound(), before);
  assert.ok(!fetches.some((u) => u.startsWith('https://api.groq.com/')));
});

test('an empty transcript also asks the patient to type', async () => {
  groqText = '';
  const { bot, calls } = await mariaMidCheckin();
  await bot.handleUpdate(voiceUpdate(CHAT));
  assert.equal(h.lastSent(calls).text, i18n.t('es', 'voice_unavailable'));
});

test('a failed Telegram download falls back to asking the patient to type', async () => {
  const { bot, calls } = await mariaMidCheckin({
    getFile: () => {
      throw new Error('file is temporarily unavailable');
    },
  });
  await bot.handleUpdate(voiceUpdate(CHAT));
  assert.equal(h.lastSent(calls).text, i18n.t('es', 'voice_unavailable'));
});

test('an oversized voice note is refused before downloading', async () => {
  const { bot, calls } = await mariaMidCheckin();
  await bot.handleUpdate(voiceUpdate(CHAT, { size: telegram.MAX_FILE_BYTES + 1 }));
  assert.equal(h.lastSent(calls).text, i18n.t('es', 'file_too_large'));
  assert.equal(fetches.length, 0);
  assert.ok(!calls.some((c) => c.method === 'getFile'));
});

test('voice from an unlinked chat asks for a code', async () => {
  const { bot, calls } = h.makeBot({ results: { getFile: getFileResult() } });
  await bot.handleUpdate(voiceUpdate(999));
  assert.equal(h.lastSent(calls).text, i18n.t('en', 'unknown_code'));
  assert.equal(fetches.length, 0);
});

test('voice mode: every reply is sent as text first, then as audio', async () => {
  const { bot, calls } = await mariaMidCheckin();
  await bot.handleUpdate(h.textUpdate(CHAT, '/voice'));
  const before = calls.length;
  await bot.handleUpdate(h.textUpdate(CHAT, '176'));
  const after = calls.slice(before).map((c) => c.method);
  assert.deepEqual(after, ['sendChatAction', 'sendMessage', 'sendAudio']); // 'typing…' first
  const audio = calls.at(-1).payload.audio;
  assert.equal(typeof audio, 'string');
  assert.equal(new URL(audio).searchParams.get('tl'), 'es');
  const { speakable } = await import('../src/integrations/speech.js');
  assert.equal(new URL(audio).searchParams.get('q'), speakable(i18n.t('es', 'ask_breath')));
});

test('voice mode: /checkin prompts are spoken too', async () => {
  const { bot, calls } = await mariaMidCheckin();
  await bot.handleUpdate(h.textUpdate(CHAT, '/voice'));
  const before = calls.length;
  await bot.handleUpdate(h.textUpdate(CHAT, '/checkin'));
  assert.equal(calls.slice(before).filter((c) => c.method === 'sendAudio').length, 2);
});

test('if Telegram cannot fetch the TTS url, we download it and upload the mp3', async () => {
  let attempts = 0;
  const { bot, calls } = await mariaMidCheckin({
    sendAudio: (payload) => {
      attempts++;
      if (typeof payload.audio === 'string') throw new Error('failed to get HTTP URL content');
      return { message_id: 1, date: 0, chat: { id: CHAT, type: 'private' } };
    },
  });
  await bot.handleUpdate(h.textUpdate(CHAT, '/voice'));
  await bot.handleUpdate(h.textUpdate(CHAT, '176'));
  assert.equal(attempts, 2);
  assert.ok(fetches.some((u) => u.includes('translate.google.com')));
  assert.equal(calls.filter((c) => c.method === 'sendAudio').at(-1).payload.audio.constructor.name, 'InputFile');
});

test('a TTS failure never blocks the text reply', async () => {
  const { bot, calls } = await mariaMidCheckin({
    sendAudio: () => {
      throw new Error('boom');
    },
  });
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  await bot.handleUpdate(h.textUpdate(CHAT, '/voice'));
  const err = console.error;
  console.error = () => {};
  try {
    await bot.handleUpdate(h.textUpdate(CHAT, '176'));
  } finally {
    console.error = err;
  }
  assert.equal(h.lastSent(calls).text, i18n.t('es', 'ask_breath'));
});

test('proactive sends honour voice mode through channels.sendToPatient', async () => {
  const { bot, calls } = h.makeBot();
  telegram.useBot(bot);
  store.updatePatient('p1', { chatId: CHAT, voiceMode: true });
  const ok = await channels.sendToPatient(store.getPatient('p1'), { text: 'Hola Maria' });
  assert.equal(ok, true);
  assert.deepEqual(calls.map((c) => c.method), ['sendMessage', 'sendAudio']);
  assert.equal(new URL(calls[1].payload.audio).searchParams.get('tl'), 'es');

  store.updatePatient('p1', { voiceMode: false });
  await channels.sendToPatient(store.getPatient('p1'), { text: 'Hola' });
  assert.equal(calls.at(-1).method, 'sendMessage');
});
