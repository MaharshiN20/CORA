// Provider chain selection with a fake fetch: no real Ollama / LM Studio / Claude needed.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as llm from '../src/core/llm/index.js';
import { pickModel } from '../src/core/llm/openaiCompat.js';

const realFetch = globalThis.fetch;
const ENV_KEYS = ['LLM_PROVIDER', 'ANTHROPIC_API_KEY', 'OLLAMA_URL', 'OLLAMA_MODEL', 'LMSTUDIO_URL', 'LMSTUDIO_MODEL'];
let savedEnv;

// routes: { 'GET http://localhost:11434/api/tags': () => body | throws, 'POST ...': (reqBody) => body }
function mockFetch(routes) {
  globalThis.fetch = async (url, opts = {}) => {
    const key = `${opts.method ?? 'GET'} ${url}`;
    const handler = routes[key];
    if (!handler) throw new Error(`connect ECONNREFUSED (${key})`);
    const body = await handler(opts.body ? JSON.parse(opts.body) : undefined);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

const OLLAMA_TAGS = 'GET http://localhost:11434/api/tags';
const OLLAMA_CHAT = 'POST http://localhost:11434/v1/chat/completions';
const LMS_MODELS = 'GET http://localhost:1234/v1/models';
const LMS_CHAT = 'POST http://localhost:1234/v1/chat/completions';
const chatReply = (content) => ({ choices: [{ message: { content } }] });

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  llm._reset();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(savedEnv)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

test('nothing available -> none, and calls return null (rule fallbacks)', async () => {
  mockFetch({});
  await llm.detect({ force: true });
  assert.equal(llm.status().provider, 'none');
  assert.equal(llm.enabled(), false);
  assert.equal(await llm.complete('sys', 'hi'), null);
});

test('Ollama running -> picks Ollama and prefers a multilingual instruct model', async () => {
  mockFetch({ [OLLAMA_TAGS]: () => ({ models: [{ name: 'nomic-embed-text' }, { name: 'phi3:mini' }, { name: 'qwen2.5:7b-instruct' }] }) });
  await llm.detect({ force: true });
  assert.deepEqual(llm.status(), { provider: 'ollama', model: 'qwen2.5:7b-instruct', available: ['ollama'] });
});

test('Ollama down, LM Studio up -> LM Studio', async () => {
  mockFetch({ [LMS_MODELS]: () => ({ data: [{ id: 'meta-llama-3.1-8b-instruct' }] }) });
  await llm.detect({ force: true });
  assert.equal(llm.status().provider, 'lmstudio');
  assert.equal(llm.status().model, 'meta-llama-3.1-8b-instruct');
});

test('Ollama running but no models pulled -> skipped', async () => {
  mockFetch({ [OLLAMA_TAGS]: () => ({ models: [] }), [LMS_MODELS]: () => ({ data: [{ id: 'gemma-2-9b' }] }) });
  await llm.detect({ force: true });
  assert.equal(llm.status().provider, 'lmstudio');
});

test('Claude key set -> Claude first, local providers kept as fallbacks', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  mockFetch({ [OLLAMA_TAGS]: () => ({ models: [{ name: 'llama3.1:8b' }] }) });
  await llm.detect({ force: true });
  assert.equal(llm.status().provider, 'claude');
  assert.deepEqual(llm.status().available, ['claude', 'ollama']);
});

test('LLM_PROVIDER pins a provider; none disables', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  mockFetch({
    [OLLAMA_TAGS]: () => ({ models: [{ name: 'llama3.1:8b' }] }),
    [LMS_MODELS]: () => ({ data: [{ id: 'qwen2.5-7b-instruct' }] }),
  });
  process.env.LLM_PROVIDER = 'lmstudio';
  await llm.detect({ force: true });
  assert.deepEqual(llm.status().available, ['lmstudio']);

  process.env.LLM_PROVIDER = 'none';
  await llm.detect({ force: true });
  assert.equal(llm.status().provider, 'none');
});

test('env model override wins over auto-pick', async () => {
  process.env.OLLAMA_MODEL = 'mistral:7b';
  mockFetch({ [OLLAMA_TAGS]: () => ({ models: [{ name: 'qwen2.5:7b' }] }) });
  await llm.detect({ force: true });
  assert.equal(llm.status().model, 'mistral:7b');
});

test('runtime failure falls through to the next provider', async () => {
  let sent;
  mockFetch({
    [OLLAMA_TAGS]: () => ({ models: [{ name: 'qwen2.5:7b' }] }),
    [OLLAMA_CHAT]: () => new Response('model crashed', { status: 500 }),
    [LMS_MODELS]: () => ({ data: [{ id: 'llama-3-8b' }] }),
    [LMS_CHAT]: (body) => {
      sent = body;
      return chatReply('  hola  ');
    },
  });
  await llm.detect({ force: true });
  assert.equal(await llm.complete('Translate to Spanish', 'hello'), 'hola');
  assert.equal(sent.model, 'llama-3-8b');
  assert.equal(sent.messages[0].role, 'system');
});

test('completeJSON requests JSON mode and extracts the object from chatty output', async () => {
  let sent;
  mockFetch({
    [OLLAMA_TAGS]: () => ({ models: [{ name: 'qwen2.5:7b' }] }),
    [OLLAMA_CHAT]: (body) => {
      sent = body;
      return chatReply('Sure! {"weightLb": 177, "swelling": "worse"} Hope that helps.');
    },
  });
  await llm.detect({ force: true });
  assert.deepEqual(await llm.completeJSON('extract', '177 lb, ankles worse'), { weightLb: 177, swelling: 'worse' });
  assert.deepEqual(sent.response_format, { type: 'json_object' });
});

test('LM Studio gets json_schema format (it rejects json_object)', async () => {
  let sent;
  mockFetch({
    [LMS_MODELS]: () => ({ data: [{ id: 'llama-3-8b' }] }),
    [LMS_CHAT]: (body) => {
      sent = body;
      return chatReply('{"ok": true}');
    },
  });
  await llm.detect({ force: true });
  assert.deepEqual(await llm.completeJSON('x', 'y'), { ok: true });
  assert.equal(sent.response_format.type, 'json_schema');
});

test('reasoning models: /no_think for qwen3, <think> stripped, retry when budget exhausted', async () => {
  const calls = [];
  mockFetch({
    [LMS_MODELS]: () => ({ data: [{ id: 'qwen/qwen3-4b' }] }),
    [LMS_CHAT]: (body) => {
      calls.push(body);
      if (calls.length === 1) return { choices: [{ message: { content: '' }, finish_reason: 'length' }] };
      return chatReply('<think>hmm, Vietnamese...</think>\nCân nặng của bạn?');
    },
  });
  await llm.detect({ force: true });
  assert.equal(await llm.complete('Translate', 'weight?', 100), 'Cân nặng của bạn?');
  assert.match(calls[0].messages[0].content, /\/no_think$/);
  assert.equal(calls[1].max_tokens, 400);
});

test('pickModel skips embedding models and prefers known instruct families', () => {
  assert.equal(pickModel(['nomic-embed-text', 'phi3', 'llama3.2:3b']), 'llama3.2:3b');
  assert.equal(pickModel(['text-embedding-nomic', 'some-custom-model']), 'some-custom-model');
  assert.equal(pickModel(['nomic-embed-text']), null);
});
