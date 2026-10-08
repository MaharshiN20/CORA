// Phase 3: the AI reviewer is escalate-only and well-behaved: bounded concurrency, one review per
// patient at a time, no repeat alerts from old messages, and safe on bad tier input.
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-aireview-hard-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.RISK_LLM;

let store, aireview, llm, riskllm, lexicon;
const realFetch = globalThis.fetch;
before(async () => {
  store = await import('../src/store.js');
  aireview = await import('../src/core/aireview.js');
  llm = await import('../src/core/llm/index.js');
  riskllm = await import('../src/riskllm/index.js');
  lexicon = await import('../src/riskllm/lexicon.js');
});
beforeEach(async () => {
  store.reset();
  aireview.setReviewer(null);
  process.env.LLM_PROVIDER = 'lmstudio';
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }] }));
    if (u.includes('localhost:1234') || u.includes('localhost:11434')) return new Response('no model in tests', { status: 503 });
    return realFetch(url, opts);
  };
  await llm.detect({ force: true });
});
afterEach(async () => {
  await aireview.flushReviews();
  globalThis.fetch = realFetch;
  process.env.LLM_PROVIDER = 'none';
  llm._reset();
});

const GREEN = { tier: 'GREEN', flags: [] };
const none = async () => null;
const yellow = (text = 'Recliner sleeping') => async () => ({
  rulesTier: 'GREEN', aiTier: 'YELLOW', finalTier: 'YELLOW', escalate: true, urgent: false, readmissionRisk: 'moderate',
  concerns: [{ category: 'congestion', text, evidence: 'slept in my recliner' }], nurseSummary: 's', suggestedActions: ['call'], model: 'test', ts: new Date().toISOString(),
});
const addMsg = (patientId, text) => store.addMessage({ patientId, direction: 'in', from: 'patient', text });
const gate = () => {
  let release;
  const open = new Promise((r) => (release = r));
  return { open, release };
};

// ---- mergeTier ----
test('mergeTier: the AI can raise GREEN to YELLOW, never lowers, never reaches RED', () => {
  assert.equal(riskllm.mergeTier('GREEN', 'YELLOW'), 'YELLOW');
  assert.equal(riskllm.mergeTier('GREEN', 'RED'), 'YELLOW');
  assert.equal(riskllm.mergeTier('YELLOW', 'GREEN'), 'YELLOW');
  assert.equal(riskllm.mergeTier('RED', 'GREEN'), 'RED');
  assert.equal(riskllm.mergeTier('RED', 'YELLOW'), 'RED');
});
test('mergeTier: an unknown tier on either side can never cause an escalation', () => {
  assert.equal(riskllm.mergeTier('ORANGE', 'YELLOW'), 'ORANGE');
  assert.equal(riskllm.mergeTier(null, 'YELLOW'), 'YELLOW', 'a missing rules tier defaults to GREEN, as documented');
  assert.equal(riskllm.mergeTier('GREEN', 'MAYBE'), 'GREEN');
  assert.equal(riskllm.mergeTier('GREEN', undefined), 'GREEN');
});

// ---- one review per patient at a time ----
test('a second review for a patient already being reviewed joins the first (one model call)', async () => {
  const g = gate();
  let calls = 0;
  aireview.setReviewer(async () => {
    calls++;
    await g.open;
    return null;
  });
  const a = aireview.queueReview('p5', GREEN);
  const b = aireview.queueReview('p5', GREEN);
  assert.equal(a, b, 'same promise');
  g.release();
  await aireview.flushReviews();
  assert.equal(calls, 1);
  aireview.queueReview('p5', GREEN); // after it finished, a new one is allowed
  await aireview.flushReviews();
  assert.equal(calls, 2);
});

// ---- bounded concurrency ----
test('at most 2 reviews run at once; the rest wait their turn and all complete', async () => {
  let running = 0;
  let peak = 0;
  let done = 0;
  const g = gate();
  aireview.setReviewer(async () => {
    running++;
    peak = Math.max(peak, running);
    await g.open;
    running--;
    done++;
    return null;
  });
  for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) aireview.queueReview(id, GREEN);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(running, 2, 'two in flight, three queued');
  g.release();
  await aireview.flushReviews();
  assert.equal(done, 5);
  assert.equal(peak, 2);
});

// ---- no repeat alerts ----
test('an open AI-review alert means no second review (and no second alert) until it is handled', async () => {
  let calls = 0;
  aireview.setReviewer(async (...args) => {
    calls++;
    return yellow()(...args);
  });
  addMsg('p5', 'I slept in my recliner');
  await aireview.queueReview('p5', GREEN);
  assert.equal(store.listAlerts().filter((a) => a.source === 'ai_review').length, 1);
  await aireview.queueReview('p5', GREEN);
  assert.equal(calls, 1, 'skipped while the first alert is open');
  assert.equal(store.listAlerts().filter((a) => a.source === 'ai_review').length, 1);
  const open = store.listAlerts().find((a) => a.source === 'ai_review');
  store.updateAlert(open.id, { status: 'resolved' });
  addMsg('p5', 'still in the recliner');
  await aireview.queueReview('p5', GREEN);
  assert.equal(calls, 2, 'reviewed again once the nurse closed it');
});
test('the reviewer is only shown messages newer than the last review', async () => {
  const seen = [];
  aireview.setReviewer(async (_p, { messages }) => {
    seen.push(messages.map((m) => m.text));
    return null;
  });
  addMsg('p5', 'old message about swelling');
  await aireview.queueReview('p5', GREEN);
  assert.deepEqual(seen[0], ['old message about swelling']);
  // a review that returned null writes no audit row, so the watermark is the review itself
  addMsg('p5', 'a new message');
  await aireview.queueReview('p5', GREEN);
  assert.deepEqual(seen[1], ['a new message']);
});

// ---- lexicon negation ----
test('negation stops at the sentence boundary: "No pain. Swollen ankles" still finds the swelling', () => {
  const ids = (t) => lexicon.matchCues(t).map((c) => c.id);
  assert.ok(ids('No pain. My ankles are swollen').length > 0, 'cue found across the full stop');
  assert.ok(ids('I feel fine, shoes are tight').length > 0);
  assert.ok(ids('no problems but my ankles are swollen').length > 0, '"but" ends the negation');
});
test('negation still works inside a sentence', () => {
  assert.equal(lexicon.matchCues('no swollen ankles').length, 0);
  assert.equal(lexicon.matchCues('my ankles are not swollen').length, 0);
  assert.equal(lexicon.matchCues('sin hinchazon en los tobillos').length, 0);
});
