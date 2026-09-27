// integrations/speech.js (K3): Groq Whisper + Google TTS, with fetch mocked. Never hits the network.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { transcribe, tts, speakable, ttsLang } from '../src/integrations/speech.js';

const realFetch = globalThis.fetch;
let requests;

function mockFetch(handler) {
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    return handler(String(url), init);
  };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  requests = [];
  process.env.GROQ_API_KEY = 'gsk_test';
  mockFetch(() => {
    throw new Error('unexpected fetch');
  });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GROQ_API_KEY;
});

const OGG = Buffer.from('OggS fake opus bytes');

// ---------- transcribe ----------
test('transcribe returns null without GROQ_API_KEY and never calls the network', async () => {
  delete process.env.GROQ_API_KEY;
  assert.equal(await transcribe(OGG, 'audio/ogg', 'es'), null);
  assert.equal(requests.length, 0);
});

test('transcribe posts a multipart whisper request and returns the trimmed text', async () => {
  mockFetch(() => json({ text: '  ciento setenta y seis libras  ' }));
  const text = await transcribe(OGG, 'audio/ogg', 'es');
  assert.equal(text, 'ciento setenta y seis libras');
  const [req] = requests;
  assert.equal(req.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(req.init.method, 'POST');
  assert.equal(req.init.headers.Authorization, 'Bearer gsk_test');
  const form = req.init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('model'), 'whisper-large-v3');
  assert.equal(form.get('language'), 'es');
  const file = form.get('file');
  assert.equal(file.name, 'voice.ogg');
  assert.equal(file.type, 'audio/ogg');
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), OGG.toString());
});

test('transcribe names the upload after its mime type and skips odd language hints', async () => {
  mockFetch(() => json({ text: 'hi' }));
  await transcribe(OGG, 'audio/mpeg', 'es-MX');
  const form = requests[0].init.body;
  assert.equal(form.get('file').name, 'voice.mp3');
  assert.equal(form.get('language'), null);
});

test('transcribe returns null on an HTTP error', async () => {
  mockFetch(() => json({ error: { message: 'rate limited' } }, 429));
  assert.equal(await transcribe(OGG, 'audio/ogg'), null);
});

test('transcribe returns null when the network throws', async () => {
  mockFetch(() => {
    throw new TypeError('fetch failed');
  });
  assert.equal(await transcribe(OGG, 'audio/ogg'), null);
});

test('transcribe returns null for an empty transcript or empty audio', async () => {
  mockFetch(() => json({ text: '   ' }));
  assert.equal(await transcribe(OGG, 'audio/ogg'), null);
  assert.equal(await transcribe(Buffer.alloc(0), 'audio/ogg'), null);
  assert.equal(requests.length, 1, 'empty audio is not uploaded');
});

// ---------- tts ----------
test('tts for short text returns a Google TTS url without any network call', async () => {
  const out = await tts('¿Cómo está su respiración hoy?', 'es');
  const url = new URL(out.url);
  assert.match(url.hostname, /translate\.google\.com/);
  assert.equal(url.searchParams.get('tl'), 'es');
  assert.equal(url.searchParams.get('q'), '¿Cómo está su respiración hoy?');
  assert.equal(requests.length, 0);
});

test('tts strips emojis and maps language codes Google names differently', async () => {
  const out = await tts('😊 Normal 💙', 'zh');
  const url = new URL(out.url);
  assert.equal(url.searchParams.get('q'), 'Normal');
  assert.equal(url.searchParams.get('tl'), 'zh-CN');
  assert.equal(ttsLang('en'), 'en');
  assert.equal(ttsLang(undefined), 'en');
  assert.equal(speakable('🚨 CALL 911 ⬇️\n ok'), 'CALL 911\nok');
});

test('tts returns null for text that is empty once emojis are removed', async () => {
  assert.equal(await tts('💙🚨', 'en'), null);
  assert.equal(await tts('', 'en'), null);
});

test('tts for long text downloads every chunk and joins them into one mp3', async () => {
  mockFetch((url) => new Response(Buffer.from(`[${new URL(url).searchParams.get('textlen')}]`)));
  const long = 'Keep salt low today. '.repeat(20); // ~420 chars -> several chunks
  const out = await tts(long, 'en');
  assert.equal(out.mime, 'audio/mpeg');
  assert.ok(requests.length >= 3, `${requests.length} chunks`);
  assert.ok(requests.every((r) => r.url.includes('translate.google.com')));
  assert.equal(out.buffer.toString().split('][').length, requests.length);
});

test('tts returns null when a long-text chunk fails to download', async () => {
  mockFetch(() => new Response('nope', { status: 503 }));
  assert.equal(await tts('Take breaks when walking. '.repeat(15), 'en'), null);
});
