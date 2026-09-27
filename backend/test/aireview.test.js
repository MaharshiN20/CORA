// P1-9: the escalate-only AI reviewer is wired into check-in completion safely.
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-aireview-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.RISK_LLM;

let store, agent, aireview, llm;
const realFetch = globalThis.fetch;
before(async () => {
  store = await import('../src/store.js');
  agent = await import('../src/core/agent.js');
  aireview = await import('../src/core/aireview.js');
  llm = await import('../src/core/llm/index.js');
});

// Pretend a local model is available (the chain only needs a model list to report a provider).
async function withProvider() {
  process.env.LLM_PROVIDER = 'lmstudio';
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }] }));
    // Never reach a real local model from tests (parser/translation calls fail -> rule fallbacks).
    if (u.includes('localhost:1234') || u.includes('localhost:11434')) return new Response('no model in tests', { status: 503 });
    return realFetch(url, opts);
  };
  await llm.detect({ force: true });
}

beforeEach(async () => {
  store.reset();
  aireview.setReviewer(null);
  await withProvider();
});
afterEach(async () => {
  await aireview.flushReviews();
  globalThis.fetch = realFetch;
  process.env.LLM_PROVIDER = 'none';
  llm._reset();
});

// Dorothy (Low risk, stable weights): a clean GREEN check-in.
async function greenCheckin(text = '140') {
  await agent.startCheckin('p5');
  await agent.handleInbound({ patientId: 'p5', buttonData: 'ci:rf:none' });
  await agent.handleInbound({ patientId: 'p5', text });
  for (const b of ['ci:breath:normal', 'ci:swell:none', 'ci:diu:yes']) await agent.handleInbound({ patientId: 'p5', buttonData: b });
}
const escalating = (extra = {}) => async () => ({
  rulesTier: 'GREEN', aiTier: 'YELLOW', finalTier: 'YELLOW', escalate: true, urgent: false, readmissionRisk: 'moderate',
  concerns: [{ category: 'congestion', text: 'Sleeping in a recliner (possible orthopnea)', evidence: 'slept in my recliner' }],
  nurseSummary: 'Possible early congestion despite normal answers.', suggestedActions: ['Call today'], model: 'test', ts: new Date().toISOString(),
  ...extra,
});
const aiAlerts = () => store.listAlerts().filter((a) => a.source === 'ai_review');

test('GREEN check-in + reviewer escalates -> YELLOW "AI review" alert with evidence', async () => {
  aireview.setReviewer(escalating());
  await greenCheckin();
  await aireview.flushReviews();
  assert.equal(store.getPatient('p5').lastTier, 'GREEN'); // rules result is untouched
  const [a] = aiAlerts();
  assert.equal(a.tier, 'YELLOW');
  assert.equal(a.kind, 'triage');
  assert.match(a.reasons[0], /recliner.*patient: "slept in my recliner"/);
  assert.equal(a.nurseSummary, 'Possible early congestion despite normal answers.');
  assert.equal(store.listAudit('p5').find((e) => e.type === 'ai_review').data.finalTier, 'YELLOW');
});

test('reviewer returns null -> rules stand silently (no alert, no audit)', async () => {
  aireview.setReviewer(async () => null);
  await greenCheckin();
  await aireview.flushReviews();
  assert.equal(aiAlerts().length, 0);
  assert.ok(!store.listAudit('p5').some((e) => e.type === 'ai_review'));
});

test('reviewer never runs when the rules already escalated (YELLOW/RED)', async () => {
  let calls = 0;
  aireview.setReviewer(async () => { calls++; return null; });
  await agent.handleInbound({ patientId: 'p5', text: 'chest pain' }); // RED, unprompted
  await agent.startCheckin('p1'); // Maria: weight trend -> YELLOW
  await agent.handleInbound({ patientId: 'p1', buttonData: 'ci:rf:none' });
  await agent.handleInbound({ patientId: 'p1', text: '177' });
  for (const b of ['ci:breath:normal', 'ci:orth:no', 'ci:swell:none', 'ci:diu:yes', 'ci:spo2:none']) await agent.handleInbound({ patientId: 'p1', buttonData: b });
  await aireview.flushReviews();
  assert.equal(store.getPatient('p1').lastTier, 'YELLOW');
  assert.equal(calls, 0);
});

test('no LLM provider -> reviewer skipped (deterministic without a model)', async () => {
  process.env.LLM_PROVIDER = 'none';
  await llm.detect({ force: true });
  let calls = 0;
  aireview.setReviewer(async () => { calls++; return null; });
  await greenCheckin();
  await aireview.flushReviews();
  assert.equal(calls, 0);
});

test('a reviewer claiming RED is ignored: the AI can only ever add a YELLOW', async () => {
  aireview.setReviewer(escalating({ aiTier: 'RED', finalTier: 'RED' }));
  await greenCheckin();
  await aireview.flushReviews();
  assert.equal(aiAlerts().length, 0);
  assert.ok(!store.listAlerts().some((a) => a.tier === 'RED'));
});

test('a crashing reviewer never breaks the check-in', async () => {
  aireview.setReviewer(async () => { throw new Error('model exploded'); });
  await greenCheckin();
  await aireview.flushReviews();
  assert.equal(store.getPatient('p5').lastTier, 'GREEN');
  assert.equal(aiAlerts().length, 0);
});

test('the patient reply does not wait for the reviewer', async () => {
  let resolveReview;
  aireview.setReviewer(() => new Promise((r) => { resolveReview = r; }));
  await greenCheckin(); // returns while the review is still pending
  assert.equal(aiAlerts().length, 0);
  assert.match(store.listMessages('p5').at(-1).text, /Tips|stable|Keep it up/);
  resolveReview(escalating()());
  resolveReview = null;
});

test('reviewer receives the English text of recent patient messages (not button noise)', async () => {
  let got;
  aireview.setReviewer(async (_p, input) => { got = input; return null; });
  // (a recliner is now caught by the rules as orthopnea, so use something only the reviewer reads)
  await greenCheckin('140, a bit more tired than usual');
  await aireview.flushReviews();
  assert.equal(got.rules.tier, 'GREEN');
  assert.ok(got.messages.some((m) => /tired/.test(m.text)));
  assert.ok(got.messages.every((m) => !m.text.startsWith('[')));
});
