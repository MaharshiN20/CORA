// Risk LLM on the shared provider chain (core/llm). Fake fetch: no real Ollama / LM Studio / Claude.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as llm from '../src/core/llm/index.js';
import * as clock from '../src/core/clock.js';
import { reviewPatient, normalizeReview, parseJSON } from '../src/riskllm/index.js';
import { buildCase } from '../src/riskllm/features.js';

const realFetch = globalThis.fetch;
const ENV_KEYS = ['LLM_PROVIDER', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_BASE_URL', 'OLLAMA_URL', 'OLLAMA_MODEL', 'LMSTUDIO_URL', 'LMSTUDIO_MODEL', 'RISK_LLM'];
let savedEnv;
let chatCalls;

const OLLAMA_TAGS = 'GET http://localhost:11434/api/tags';
const OLLAMA_CHAT = 'POST http://localhost:11434/v1/chat/completions';

// routes: { 'GET url': () => body, 'POST url': (reqBody) => body }; anything else refuses to connect.
function mockFetch(routes) {
  globalThis.fetch = async (url, opts = {}) => {
    const key = `${opts.method ?? 'GET'} ${url}`;
    const handler = routes[key];
    if (!handler) throw new Error(`connect ECONNREFUSED (${key})`);
    const body = await handler(opts.body ? JSON.parse(opts.body) : undefined);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

const ollamaReplying = (content) => ({
  [OLLAMA_TAGS]: () => ({ models: [{ name: 'qwen2.5:7b' }] }),
  [OLLAMA_CHAT]: (req) => {
    chatCalls.push(req);
    return { choices: [{ message: { content }, finish_reason: 'stop' }] };
  },
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-26T12:00:00Z');
const iso = (daysAgo, base = NOW) => new Date(base - daysAgo * DAY).toISOString();
const patient = (base = NOW) => ({
  age: 71,
  dischargedAt: iso(6, base),
  dryWeightLb: 205,
  profile: {},
  weights: [205, 205.6, 206.3, 207, 207.9, 208.8].map((lb, i) => ({ ts: iso(5 - i, base), lb })),
  doses: [],
  prescriptions: [],
});

const YELLOW = {
  tier: 'YELLOW',
  urgent: false,
  readmissionRisk: 'high',
  concerns: [{ category: 'fluid_trend', text: 'Weight creeping up', evidence: '+3.8 lb in 5 days' }],
  nurseSummary: 'Slow fluid build-up.',
  suggestedActions: ['Call today'],
};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  llm._reset();
  clock.reset();
  chatCalls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  clock.reset();
  for (const [k, v] of Object.entries(savedEnv)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

test('runs through the chain (Ollama) and reports the chain model', async () => {
  process.env.LLM_PROVIDER = 'ollama';
  // Models often wrap JSON in prose / code fences; we still extract it.
  mockFetch(ollamaReplying('Here you go:\n```json\n' + JSON.stringify(YELLOW) + '\n```'));
  const r = await reviewPatient(patient(), { rules: { tier: 'GREEN', flags: [] }, now: NOW, messages: [{ ts: iso(0), text: 'had canned soup' }] });
  assert.equal(r.finalTier, 'YELLOW');
  assert.equal(r.escalate, true);
  assert.equal(r.model, 'qwen2.5:7b');
  assert.equal(chatCalls.length, 1);
  // Big enough budget for a full review, schema in the system prompt, case + messages in the user turn.
  assert.ok(chatCalls[0].max_tokens >= 1000);
  assert.match(chatCalls[0].messages[0].content, /JSON Schema/);
  assert.match(chatCalls[0].messages[1].content, /canned soup/);
  // Code-detected sodium signal merged in even though the model didn't mention it.
  assert.ok(r.concerns.some((c) => c.category === 'diet_sodium'));
});

test('no provider available -> null (rules stand)', async () => {
  process.env.LLM_PROVIDER = 'none';
  mockFetch({});
  assert.equal(await reviewPatient(patient(), { now: NOW }), null);

  delete process.env.LLM_PROVIDER; // auto, but nothing reachable
  llm._reset();
  assert.equal(await reviewPatient(patient(), { now: NOW }), null);
});

test('RISK_LLM=off disables the reviewer even when a provider is up', async () => {
  process.env.RISK_LLM = 'off';
  process.env.LLM_PROVIDER = 'ollama';
  mockFetch(ollamaReplying(JSON.stringify(YELLOW)));
  assert.equal(await reviewPatient(patient(), { now: NOW }), null);
  assert.equal(await reviewPatient(patient(), { now: NOW }, { call: async () => YELLOW }), null);
  assert.equal(chatCalls.length, 0);
});

test('unusable model output -> null', async () => {
  process.env.LLM_PROVIDER = 'ollama';
  for (const bad of ['sorry, I cannot help', '{"tier": "ORANGE"}', '{not json']) {
    llm._reset();
    mockFetch(ollamaReplying(bad));
    assert.equal(await reviewPatient(patient(), { now: NOW }), null, bad);
  }
});

test('a hung provider times out -> null', async () => {
  const hang = () => new Promise(() => {});
  assert.equal(await reviewPatient(patient(), { now: NOW }, { call: hang, timeoutMs: 20 }), null);
});

test('AI saying RED is capped at YELLOW; RED from rules is never lowered', async () => {
  const red = async () => ({ ...YELLOW, tier: 'RED' });
  assert.equal((await reviewPatient(patient(), { rules: { tier: 'GREEN' }, now: NOW }, { call: red })).finalTier, 'YELLOW');
  const green = async () => ({ ...YELLOW, tier: 'GREEN' });
  assert.equal((await reviewPatient(patient(), { rules: { tier: 'RED' }, now: NOW }, { call: green })).finalTier, 'RED');
});

test('normalizeReview coerces loose output to the contract shape', () => {
  const n = normalizeReview({
    tier: 'YELLOW',
    urgent: 'yes', // not a boolean -> false
    readmissionRisk: 'very high', // not in enum -> null
    concerns: [{ category: 'vibes', text: 'x', evidence: 5 }, { text: '' }, null],
    nurseSummary: 42,
    suggestedActions: ['ok', 7, ''],
  });
  assert.deepEqual(n.concerns, [{ category: 'other', text: 'x', evidence: '' }]);
  assert.equal(n.urgent, false);
  assert.equal(n.readmissionRisk, null);
  assert.equal(n.nurseSummary, '');
  assert.deepEqual(n.suggestedActions, ['ok']);
  assert.equal(normalizeReview(null), null);
  assert.equal(normalizeReview({ tier: 'green' }), null);
});

test('parseJSON finds the object inside prose', () => {
  assert.deepEqual(parseJSON('blah {"a":1} blah'), { a: 1 });
  assert.equal(parseJSON('no json here'), null);
  assert.equal(parseJSON(null), null);
});

test('time defaults to the demo clock, so advancing it moves the case forward', () => {
  const p = patient(Date.now()); // discharged 6 real days ago
  assert.equal(buildCase(p).patient.daysSinceDischarge, 6);
  clock.advance(3 * DAY);
  assert.equal(buildCase(p).patient.daysSinceDischarge, 9);
});
