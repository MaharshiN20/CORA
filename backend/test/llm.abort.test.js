// K12: an AI review that is given up on cancels the model request it started, all the way
// down (aireview -> riskllm -> the provider chain -> the provider). Fake providers, no network.
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-llm-abort-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
process.env.LLM_RETRY_DELAY_MS = '1';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.RISK_LLM;

let llm, riskllm, aireview, store;
const realFetch = globalThis.fetch;
const ENV_KEYS = ['LLM_PROVIDER', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OLLAMA_URL', 'OLLAMA_MODEL'];
let savedEnv;
let savedError;
let keepAlive;

before(async () => {
  store = await import('../src/store.js');
  llm = await import('../src/core/llm/index.js');
  riskllm = await import('../src/riskllm/index.js');
  aireview = await import('../src/core/aireview.js');
});
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  store.reset();
  llm._reset();
  aireview.setReviewer(null);
  savedError = console.error;
  console.error = () => {}; // "review failed / cancelled, rules stand" is the expected outcome here
  // Abort and backstop timers are unref'd; with only a hung fake pending, the event loop would
  // drain and node:test would cancel the test (a real server always has other handles).
  keepAlive = setTimeout(() => {}, 10_000);
});
afterEach(async () => {
  await aireview.flushReviews();
  clearTimeout(keepAlive);
  console.error = savedError;
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(savedEnv)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  aireview.setReviewer(null);
  llm._reset();
});

// A provider that never answers. It records the signal it was handed and, like fetch, rejects
// when that signal fires.
function hanging(name = 'slow') {
  const p = {
    name,
    model: `${name}-model`,
    calls: 0,
    signal: undefined,
    chat(opts) {
      p.calls++;
      p.signal = opts.signal;
      return new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))));
    },
  };
  return p;
}
function answering(text, name = 'fast') {
  const p = {
    name,
    model: `${name}-model`,
    calls: 0,
    signal: undefined,
    async chat(opts) {
      p.calls++;
      p.signal = opts.signal;
      return text;
    },
  };
  return p;
}
const abortAfter = (ms) => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
};
const timed = async (fn) => {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - t0 };
};

// ---------- the provider chain ----------
test('chain: the caller\'s signal reaches the provider, and aborting it ends the chain', async () => {
  const slow = hanging();
  const next = answering('never used');
  llm._use([slow, next]);
  const { value, ms } = await timed(() => llm.complete('s', 'u', 100, { signal: abortAfter(20) }));
  assert.equal(value, null);
  assert.ok(ms < 1000, `returned in ${ms.toFixed(0)} ms`);
  assert.equal(slow.calls, 1);
  assert.equal(slow.signal.aborted, true, 'the provider saw the abort');
  assert.equal(next.calls, 0, 'no fall-through to the next provider once the caller has given up');
  assert.equal(llm.status().cooling, undefined, 'a cancellation is not a provider failure');
});

test('chain: a signal that is already aborted starts nothing', async () => {
  const p = answering('hi');
  llm._use([p]);
  assert.equal(await llm.complete('s', 'u', 100, { signal: AbortSignal.abort() }), null);
  assert.equal(await llm.completeJSON('s', 'u', { signal: AbortSignal.abort() }), null);
  assert.equal(p.calls, 0);
});

test('chain: completeJSON passes the signal on as well', async () => {
  const slow = hanging();
  llm._use([slow]);
  assert.equal(await llm.completeJSON('s', 'u', { signal: abortAfter(20) }), null);
  assert.equal(slow.signal.aborted, true);
});

test('chain: with a live signal a failing provider still falls through to the next one', async () => {
  const broken = { name: 'broken', model: 'm', chat: async () => Promise.reject(new Error('500 from provider')) };
  const next = answering('fallback ok');
  llm._use([broken, next]);
  const controller = new AbortController();
  assert.equal(await llm.complete('s', 'u', 100, { signal: controller.signal }), 'fallback ok');
  assert.equal(next.signal, controller.signal);
});

test('chain: calls without a signal behave exactly as before', async () => {
  const p = answering('plain');
  llm._use([p]);
  assert.equal(await llm.complete('s', 'u'), 'plain');
  assert.equal(p.signal, undefined);
});

test('chain: deadlineMs is unchanged (null at the deadline; the provider call is left alone)', async () => {
  const slow = hanging();
  llm._use([slow]);
  const { value, ms } = await timed(() => llm.complete('s', 'u', 100, { deadlineMs: 30 }));
  assert.equal(value, null);
  assert.ok(ms >= 25 && ms < 1000, `deadline honoured (${ms.toFixed(0)} ms)`);
  assert.equal(slow.signal, undefined, 'a patient-facing deadline does not hand the provider a signal');
});

test('chain: deadlineMs and a signal together: whichever comes first ends the wait', async () => {
  const slow = hanging();
  llm._use([slow]);
  const first = await timed(() => llm.complete('s', 'u', 100, { deadlineMs: 5000, signal: abortAfter(20) }));
  assert.equal(first.value, null);
  assert.ok(first.ms < 1000);
  assert.equal(slow.signal.aborted, true);
});

// ---------- real providers: the signal reaches fetch ----------
const OLLAMA = 'http://localhost:11434';
function ollamaHanging() {
  const seen = { chats: 0, signal: undefined };
  globalThis.fetch = (url, opts = {}) => {
    const u = String(url);
    if (u === `${OLLAMA}/api/tags`) return Promise.resolve(Response.json({ models: [{ name: 'qwen2.5:7b' }] }));
    if (u === `${OLLAMA}/v1/chat/completions`) {
      seen.chats++;
      seen.signal = opts.signal;
      return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    return Promise.reject(new Error(`connect ECONNREFUSED (${u})`));
  };
  return seen;
}

test('OpenAI-compatible provider: aborting cancels the fetch, with no retry', async () => {
  process.env.LLM_PROVIDER = 'ollama';
  const seen = ollamaHanging();
  await llm.detect({ force: true });
  assert.equal(llm.status().provider, 'ollama');
  const signal = abortAfter(20);
  assert.equal(await llm.complete('s', 'u', 100, { signal, timeoutMs: 5000 }), null);
  assert.equal(seen.chats, 1);
  assert.equal(seen.signal.aborted, true);
});

test('OpenAI-compatible provider: the per-call timeout still fires when the caller\'s signal never does', async () => {
  process.env.LLM_PROVIDER = 'ollama';
  const seen = ollamaHanging();
  await llm.detect({ force: true });
  const never = new AbortController();
  const { value, ms } = await timed(() => llm.complete('s', 'u', 100, { signal: never.signal, timeoutMs: 30 }));
  assert.equal(value, null);
  assert.ok(ms < 2000);
  assert.equal(seen.signal.aborted, true, 'the fetch was cut off by the timeout');
  assert.equal(never.signal.aborted, false, "the caller's signal was not touched");
});

test('Claude provider: the signal is passed to the SDK request', async () => {
  process.env.LLM_PROVIDER = 'claude';
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  const seen = { calls: 0, signal: undefined };
  globalThis.fetch = (url, opts = {}) => {
    if (!String(url).includes('/v1/messages')) return Promise.reject(new Error(`unexpected fetch ${url}`));
    seen.calls++;
    seen.signal = opts.signal;
    return new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  };
  await llm.detect({ force: true });
  assert.equal(llm.status().provider, 'claude');
  const { value, ms } = await timed(() => llm.complete('s', 'u', 100, { signal: abortAfter(20) }));
  assert.equal(value, null);
  assert.ok(ms < 2000, `returned in ${ms.toFixed(0)} ms`);
  assert.equal(seen.calls, 1, 'no SDK retry after a cancellation');
  assert.equal(seen.signal.aborted, true);
});

// ---------- riskllm ----------
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-26T12:00:00Z');
const patient = () => ({
  age: 71,
  dischargedAt: new Date(NOW - 6 * DAY).toISOString(),
  dryWeightLb: 205,
  profile: {},
  weights: [205, 205.6, 206.3, 207, 207.9, 208.8].map((lb, i) => ({ ts: new Date(NOW - (5 - i) * DAY).toISOString(), lb })),
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

test('riskllm: after the timeout the model call\'s signal is aborted', async () => {
  let seen;
  const call = (_prompt, { signal }) => {
    seen = signal;
    return new Promise(() => {}); // a provider that never answers and ignores the signal
  };
  assert.equal(seen, undefined);
  const { value, ms } = await timed(() => riskllm.reviewPatient(patient(), { now: NOW }, { call, timeoutMs: 20 }));
  assert.equal(value, null, 'the rules result stands');
  assert.ok(ms >= 15 && ms < 1000);
  assert.ok(seen instanceof AbortSignal);
  assert.equal(seen.aborted, true);
});

test('riskllm: on the shared chain, the timeout cancels the provider in flight and stops the chain', async () => {
  const slow = hanging();
  const next = answering(JSON.stringify(YELLOW));
  llm._use([slow, next]);
  assert.equal(await riskllm.reviewPatient(patient(), { now: NOW }, { timeoutMs: 20 }), null);
  assert.equal(slow.signal.aborted, true, 'the fake provider recorded the abort');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(next.calls, 0, 'the timed-out review does not go on to the next provider in the background');
});

test('riskllm: a review that finishes in time is not aborted', async () => {
  let seen;
  const call = async (_prompt, { signal }) => {
    seen = signal;
    return YELLOW;
  };
  const review = await riskllm.reviewPatient(patient(), { rules: { tier: 'GREEN' }, now: NOW }, { call, timeoutMs: 5000 });
  assert.equal(review.finalTier, 'YELLOW');
  assert.equal(seen.aborted, false);
  const fast = answering(JSON.stringify(YELLOW));
  llm._use([fast]);
  assert.equal((await riskllm.reviewPatient(patient(), { rules: { tier: 'GREEN' }, now: NOW })).escalate, true);
  assert.equal(fast.signal.aborted, false);
});

test('riskllm: the caller can cancel a review with its own signal', async () => {
  const slow = hanging();
  llm._use([slow]);
  const { value, ms } = await timed(() => riskllm.reviewPatient(patient(), { now: NOW }, { timeoutMs: 60_000, signal: abortAfter(20) }));
  assert.equal(value, null);
  assert.ok(ms < 1000, `did not wait for the 60 s timeout (${ms.toFixed(0)} ms)`);
  assert.equal(slow.signal.aborted, true);

  const idle = answering(JSON.stringify(YELLOW));
  llm._use([idle]);
  assert.equal(await riskllm.reviewPatient(patient(), { now: NOW }, { signal: AbortSignal.abort() }), null);
  assert.equal(idle.calls, 0, 'already cancelled: no model call at all');
});

test('riskllm: a model call that throws synchronously is a failed review, not a crash', async () => {
  const call = () => {
    throw new Error('boom');
  };
  assert.equal(await riskllm.reviewPatient(patient(), { now: NOW }, { call, timeoutMs: 5000 }), null);
});

// ---------- aireview ----------
const GREEN = { tier: 'GREEN', flags: [] };
const aiAlerts = () => store.listAlerts().filter((a) => a.source === 'ai_review');
const escalation = {
  rulesTier: 'GREEN', aiTier: 'YELLOW', finalTier: 'YELLOW', escalate: true, urgent: false, readmissionRisk: 'moderate',
  concerns: [{ category: 'congestion', text: 'Sleeping in a recliner', evidence: 'slept in my recliner' }],
  nurseSummary: 'Possible early congestion.', suggestedActions: ['Call today'], model: 'test', ts: new Date().toISOString(),
};

test('aireview: a reviewer that never settles is cancelled by the backstop and its signal aborted', async () => {
  llm._use([answering('unused')]); // the review only runs when a provider is available
  let seen;
  aireview.setReviewer((_patient, _input, { signal }) => {
    seen = signal;
    return new Promise(() => {});
  }, { timeoutMs: 30 });
  const { ms } = await timed(() => aireview.queueReview('p5', GREEN));
  assert.ok(ms >= 25 && ms < 2000, `the review ended at the backstop (${ms.toFixed(0)} ms)`);
  assert.equal(seen.aborted, true);
  assert.equal(aiAlerts().length, 0, 'the rules result stands');
});

test('aireview: cancelled reviews give their slots back, so later patients are still reviewed', async () => {
  llm._use([answering('unused')]);
  const signals = {};
  aireview.setReviewer((p, _input, { signal }) => {
    signals[p.id] = signal;
    return p.id === 'p5' ? Promise.resolve(escalation) : new Promise(() => {});
  }, { timeoutMs: 30 });
  // Two reviews run at a time: p1 and p2 hang in both slots, p5 waits behind them.
  for (const id of ['p1', 'p2', 'p5']) aireview.queueReview(id, GREEN);
  await aireview.flushReviews();
  assert.equal(signals.p1.aborted, true);
  assert.equal(signals.p2.aborted, true);
  assert.equal(signals.p5.aborted, false, 'the one that finished was not aborted');
  assert.deepEqual(aiAlerts().map((a) => a.patientId), ['p5']);
});

test('aireview: with the real reviewer the cancellation travels down to the provider', async () => {
  const slow = hanging();
  llm._use([slow]);
  aireview.setReviewer(null, { timeoutMs: 30 }); // riskllm's own timeout is minutes away
  await aireview.queueReview('p5', GREEN);
  assert.equal(slow.calls, 1);
  assert.equal(slow.signal.aborted, true, 'aireview -> riskllm -> chain -> provider');
  assert.equal(aiAlerts().length, 0);
});

test('aireview: a review that finishes in time is not aborted, and setReviewer(fn) alone keeps the default backstop', async () => {
  llm._use([answering('unused')]);
  let seen;
  aireview.setReviewer(async (_p, _input, { signal }) => {
    seen = signal;
    return escalation;
  });
  await aireview.queueReview('p5', GREEN);
  assert.equal(seen.aborted, false);
  assert.equal(aiAlerts().length, 1);
});
