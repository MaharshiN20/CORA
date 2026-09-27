// Photos in the Telegram channel (K4). Telegram API calls are recorded by the harness;
// the file download is served by a mocked fetch.
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-channels-photo-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, telegram, i18n, h;

before(async () => {
  store = await import('../src/store.js');
  telegram = await import('../src/channels/telegram.js');
  i18n = await import('../src/core/i18n.js');
  h = await import('./channels.harness.js');
});

const realFetch = globalThis.fetch;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from('fake jpeg body'), 0xff, 0xd9]);
let fetches;
let download;

beforeEach(() => {
  store.reset();
  fetches = [];
  download = () => new Response(JPEG);
  globalThis.fetch = async (url) => {
    fetches.push(String(url));
    if (String(url).startsWith('https://api.telegram.org/file/bottest:token/')) return download();
    throw new Error(`unexpected fetch ${url}`);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const CHAT = 4242;
let n = 0;

function photoUpdate(chatId, { largest = 50_000 } = {}) {
  return {
    update_id: ++n,
    message: {
      message_id: 7000 + n,
      date: 0,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, is_bot: false, first_name: 'Maria' },
      photo: [
        { file_id: 'small', file_unique_id: 's', width: 90, height: 90, file_size: 1_000 },
        { file_id: 'medium', file_unique_id: 'm', width: 320, height: 320, file_size: 10_000 },
        { file_id: 'large', file_unique_id: 'l', width: 1280, height: 1280, file_size: largest },
      ],
    },
  };
}

function documentUpdate(chatId, { mime = 'image/png', size = 40_000 } = {}) {
  return {
    update_id: ++n,
    message: {
      message_id: 7000 + n,
      date: 0,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, is_bot: false, first_name: 'Maria' },
      document: { file_id: 'doc1', file_unique_id: 'd', file_name: 'bottle.png', mime_type: mime, file_size: size },
    },
  };
}

async function linkedMaria(results = {}) {
  const { bot, calls } = h.makeBot({
    results: { getFile: (p) => ({ file_id: p.file_id, file_unique_id: 'x', file_size: JPEG.length, file_path: `photos/${p.file_id}.jpg` }), ...results },
  });
  await bot.handleUpdate(h.textUpdate(CHAT, '/start GARCIA1'));
  return { bot, calls };
}

const photoAudits = () => store.listAudit('p1').filter((e) => e.type === 'photo_received');

test('a photo is downloaded at its largest size and handed to the core as base64 + mime', async () => {
  const { bot, calls } = await linkedMaria();
  await bot.handleUpdate(photoUpdate(CHAT));

  assert.equal(calls.find((c) => c.method === 'getFile').payload.file_id, 'large');
  assert.deepEqual(fetches, ['https://api.telegram.org/file/bottest:token/photos/large.jpg']);
  const [audit] = photoAudits();
  assert.equal(audit.data.mime, 'image/jpeg');
  // The core estimates size from the base64 length (padding included), so compare the same way.
  assert.equal(audit.data.bytes, Math.round(JPEG.toString('base64').length * 0.75), 'the base64 is the downloaded bytes');
  const inbound = store.listMessages('p1').filter((m) => m.direction === 'in');
  assert.equal(inbound.at(-1).text, '[photo]');
  assert.equal(inbound.at(-1).channel, 'telegram');
  assert.equal(h.lastSent(calls).text, i18n.t('es', 'photo_received'));
});

test('an image sent as a file keeps its own mime type', async () => {
  const { bot } = await linkedMaria();
  await bot.handleUpdate(documentUpdate(CHAT, { mime: 'image/png' }));
  const [audit] = photoAudits();
  assert.equal(audit.data.mime, 'image/png');
});

test('non-image documents are ignored', async () => {
  const { bot, calls } = await linkedMaria();
  const before = calls.length;
  await bot.handleUpdate(documentUpdate(CHAT, { mime: 'application/pdf' }));
  assert.equal(calls.length, before);
  assert.equal(photoAudits().length, 0);
});

test('a photo over 8 MB is refused with a friendly message and never downloaded', async () => {
  const { bot, calls } = await linkedMaria();
  await bot.handleUpdate(photoUpdate(CHAT, { largest: telegram.MAX_FILE_BYTES + 1 }));
  assert.equal(h.lastSent(calls).text, i18n.t('es', 'file_too_large'));
  assert.ok(!calls.some((c) => c.method === 'getFile'));
  assert.equal(fetches.length, 0);
  assert.equal(photoAudits().length, 0);
});

test('an oversized image document is refused too', async () => {
  const { bot, calls } = await linkedMaria();
  await bot.handleUpdate(documentUpdate(CHAT, { size: 12 * 1024 * 1024 }));
  assert.equal(h.lastSent(calls).text, i18n.t('es', 'file_too_large'));
});

test('a file that turns out larger than declared is refused after download', async () => {
  const { bot, calls } = await linkedMaria();
  download = () => new Response(Buffer.alloc(telegram.MAX_FILE_BYTES + 1));
  await bot.handleUpdate(photoUpdate(CHAT, { largest: undefined }));
  assert.equal(h.lastSent(calls).text, i18n.t('es', 'file_too_large'));
  assert.equal(photoAudits().length, 0);
});

test('a failed download does not reach the core or crash the bot', async () => {
  const { bot } = await linkedMaria();
  download = () => new Response('gone', { status: 404 });
  const err = console.error;
  console.error = () => {};
  try {
    await bot.handleUpdate(photoUpdate(CHAT));
  } finally {
    console.error = err;
  }
  assert.equal(photoAudits().length, 0);
});

test('a photo from an unlinked chat asks for a code', async () => {
  const { bot, calls } = h.makeBot();
  await bot.handleUpdate(photoUpdate(999));
  assert.equal(h.lastSent(calls).text, i18n.t('en', 'unknown_code'));
  assert.equal(fetches.length, 0);
});
