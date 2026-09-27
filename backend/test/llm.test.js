// Provider chain selection with a fake fetch: no real Ollama / LM Studio / Claude needed.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as llm from '../src/core/llm/index.js';
import { pickModel } from '../src/core/llm/openaiCompat.js';

const realFetch = globalThis.fetch;
process.env.LLM_RETRY_DELAY_MS = '1'; // keep retry tests fast
const ENV_KEYS = ['LLM_PROVIDER', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_BASE_URL', 'OLLAMA_URL', 'OLLAMA_MODEL', 'LMSTUDIO_URL', 'LMSTUDIO_MODEL'];
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
  assert.equal(calls[0].reasoning_effort, 'none'); // qwen3.5 ignores /no_think; this is what LM Studio honours
  assert.equal(calls[1].max_tokens, 400);
});

test('pickModel skips embedding models and prefers known instruct families', () => {
  assert.equal(pickModel(['nomic-embed-text', 'phi3', 'llama3.2:3b']), 'llama3.2:3b');
  assert.equal(pickModel(['text-embedding-nomic', 'some-custom-model']), 'some-custom-model');
  assert.equal(pickModel(['nomic-embed-text']), null);
});

// ---------- Gemini + per-call options ----------
const GEMINI_CHAT = 'POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

test('Gemini key set -> Gemini after Claude, before local providers; no network probe needed', async () => {
  process.env.GEMINI_API_KEY = 'g-test';
  mockFetch({ [OLLAMA_TAGS]: () => ({ models: [{ name: 'qwen2.5:7b' }] }) });
  await llm.detect({ force: true });
  assert.deepEqual(llm.status(), { provider: 'gemini', model: 'gemini-flash-latest', available: ['gemini', 'ollama'] });
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  await llm.detect({ force: true });
  assert.deepEqual(llm.status().available, ['claude', 'gemini', 'ollama']);
});

test('Gemini request: OpenAI-compatible endpoint, Bearer key, JSON mode, thinking off', async () => {
  process.env.GEMINI_API_KEY = 'g-test';
  process.env.GEMINI_MODEL = 'gemini-3.8-flash';
  let sent;
  let auth;
  globalThis.fetch = async (url, opts) => {
    assert.equal(`${opts.method} ${url}`, GEMINI_CHAT);
    auth = opts.headers.Authorization;
    sent = JSON.parse(opts.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"weightLb":177}' } }] }));
  };
  await llm.detect({ force: true });
  assert.deepEqual(await llm.completeJSON('extract', '177 lb'), { weightLb: 177 });
  assert.equal(auth, 'Bearer g-test');
  assert.equal(sent.model, 'gemini-3.8-flash');
  assert.equal(sent.reasoning_effort, 'none');
  assert.deepEqual(sent.response_format, { type: 'json_object' });
});

test('Gemini failure falls through to the next provider', async () => {
  process.env.GEMINI_API_KEY = 'g-test';
  mockFetch({
    [GEMINI_CHAT]: () => new Response('{"error":{"code":429}}', { status: 429 }),
    [LMS_MODELS]: () => ({ data: [{ id: 'llama-3-8b' }] }),
    [LMS_CHAT]: () => chatReply('fallback ok'),
  });
  await llm.detect({ force: true });
  assert.equal(await llm.complete('s', 'u'), 'fallback ok');
});

test('per-call options: maxTokens, schema, timeoutMs reach the provider', async () => {
  let sent;
  mockFetch({
    [LMS_MODELS]: () => ({ data: [{ id: 'llama-3-8b' }] }),
    [LMS_CHAT]: (body) => {
      sent = body;
      return chatReply('{"tier":"GREEN"}');
    },
  });
  await llm.detect({ force: true });
  const schema = { type: 'object', properties: { tier: { type: 'string' } } };
  assert.deepEqual(await llm.completeJSON('s', 'u', { maxTokens: 1500, schema }), { tier: 'GREEN' });
  assert.equal(sent.max_tokens, 1500);
  assert.deepEqual(sent.response_format, { type: 'json_schema', json_schema: { name: 'response', schema } });
});

test('per-call model override is used only by a provider that has that model', async () => {
  process.env.GEMINI_API_KEY = 'g-test';
  const models = [];
  mockFetch({
    [GEMINI_CHAT]: (body) => {
      models.push(['gemini', body.model]);
      return new Response('x', { status: 500 }); // force fall-through
    },
    [LMS_MODELS]: () => ({ data: [{ id: 'llama-3-8b' }, { id: 'qwen2.5-7b-instruct' }] }),
    [LMS_CHAT]: (body) => {
      models.push(['lmstudio', body.model]);
      return chatReply('ok');
    },
  });
  await llm.detect({ force: true });
  await llm.complete('s', 'u', 200, { model: 'qwen2.5-7b-instruct' });
  assert.deepEqual(models, [['gemini', 'gemini-flash-latest'], ['lmstudio', 'qwen2.5-7b-instruct']]);
});

test('per-call timeout aborts a hung provider and falls through', async () => {
  process.env.GEMINI_API_KEY = 'g-test';
  mockFetch({
    [GEMINI_CHAT]: () => new Promise(() => {}), // never answers
    [LMS_MODELS]: () => ({ data: [{ id: 'llama-3-8b' }] }),
    [LMS_CHAT]: () => chatReply('lm studio answered'),
  });
  // mockFetch ignores AbortSignal; wrap it so the hung call rejects on abort like real fetch.
  const inner = globalThis.fetch;
  globalThis.fetch = (url, opts) =>
    new Promise((resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      inner(url, opts).then(resolve, reject);
    });
  await llm.detect({ force: true });
  // AbortSignal.timeout's timer is unref'd; with only a hung fake request pending the event loop
  // would drain and node:test would cancel the test (a real server always has other handles).
  const keepAlive = setTimeout(() => {}, 5000);
  const t0 = Date.now();
  try {
    assert.equal(await llm.complete('s', 'u', 100, { timeoutMs: 50 }), 'lm studio answered');
    assert.ok(Date.now() - t0 < 2000);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('a 503 "high demand" spike is retried once on the same provider before falling through', async () => {
  process.env.GEMINI_API_KEY = 'g-test';
  let n = 0;
  mockFetch({
    [GEMINI_CHAT]: () => (++n === 1 ? new Response('{"error":{"code":503}}', { status: 503 }) : chatReply('second try ok')),
  });
  await llm.detect({ force: true });
  assert.equal(await llm.complete('s', 'u'), 'second try ok');
  assert.equal(n, 2);
});

test('a 400 is not retried', async () => {
  process.env.GEMINI_API_KEY = 'g-test';
  let n = 0;
  mockFetch({ [GEMINI_CHAT]: () => (n++, new Response('bad', { status: 400 })) });
  await llm.detect({ force: true });
  assert.equal(await llm.complete('s', 'u'), null);
  assert.equal(n, 1);
});

test('an exhausted quota (429 "quota") puts the provider on cooldown: later calls skip it', async () => {
  process.env.GEMINI_API_KEY = 'g-test';
  let geminiCalls = 0;
  mockFetch({
    [GEMINI_CHAT]: () => (geminiCalls++, new Response('{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details."}}', { status: 429 })),
    [LMS_MODELS]: () => ({ data: [{ id: 'llama-3-8b' }] }),
    [LMS_CHAT]: () => chatReply('local answer'),
  });
  await llm.detect({ force: true });
  assert.equal(await llm.complete('s', 'u'), 'local answer');
  const afterFirst = geminiCalls; // 2: the call + its one retry
  assert.equal(await llm.complete('s', 'u'), 'local answer');
  assert.equal(geminiCalls, afterFirst); // skipped entirely while cooling down
  assert.equal(llm.status().provider, 'lmstudio');
  assert.deepEqual(llm.status().cooling, ['gemini']);
});

test('a rejected key (401) also cools down; a brief 503 spike does not', async () => {
  process.env.GEMINI_API_KEY = 'g-test';
  let n = 0;
  mockFetch({
    [GEMINI_CHAT]: () => (n++, new Response('{"error":"unavailable"}', { status: 503 })),
    [LMS_MODELS]: () => ({ data: [{ id: 'llama-3-8b' }] }),
    [LMS_CHAT]: () => chatReply('ok'),
  });
  await llm.detect({ force: true });
  await llm.complete('s', 'u');
  assert.equal(llm.status().cooling, undefined); // 503 = transient, keep trying Gemini
  mockFetch({ [GEMINI_CHAT]: () => new Response('bad key', { status: 401 }), [LMS_MODELS]: () => ({ data: [{ id: 'llama-3-8b' }] }), [LMS_CHAT]: () => chatReply('ok') });
  await llm.complete('s', 'u');
  assert.deepEqual(llm.status().cooling, ['gemini']);
});
