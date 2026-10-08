// What GET /api/alerts really returns for an AI-review alert. The dashboard (AlertCard.jsx,
// lib/worklist.js aiOf) is written against exactly this shape: it once read `alert.ai.*`, which no
// code ever set, so the nurse summary never appeared. If you change these fields, change the UI.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-alertcontract-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.RISK_LLM;

let store, aireview, llm, server, base;
const realFetch = globalThis.fetch;
before(async () => {
  store = await import('../src/store.js');
  aireview = await import('../src/core/aireview.js');
  llm = await import('../src/core/llm/index.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  globalThis.fetch = realFetch;
  server?.close();
  process.env.LLM_PROVIDER = 'none';
  llm._reset();
});
beforeEach(async () => {
  store.reset();
  process.env.LLM_PROVIDER = 'lmstudio';
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }] }));
    if (u.includes('localhost:1234') || u.includes('localhost:11434')) return new Response('no model', { status: 503 });
    return realFetch(url, opts);
  };
  await llm.detect({ force: true });
});

test('an AI-review alert carries its summary, suggested actions, risk and model at the top level', async () => {
  aireview.setReviewer(async () => ({
    rulesTier: 'GREEN', aiTier: 'YELLOW', finalTier: 'YELLOW', escalate: true, urgent: false, readmissionRisk: 'high',
    concerns: [{ category: 'congestion', text: 'Sleeping in a recliner', evidence: 'slept in my recliner' }],
    nurseSummary: 'Possible early congestion.', suggestedActions: ['Call today', 'Ask about pillows'], model: 'qwen-test', ts: new Date().toISOString(),
  }));
  store.addMessage({ patientId: 'p5', direction: 'in', from: 'patient', text: 'I slept in my recliner' });
  await aireview.queueReview('p5', { tier: 'GREEN', flags: [] });
  const alerts = await (await fetch(`${base}/api/alerts`)).json();
  const a = alerts.find((x) => x.source === 'ai_review');
  assert.ok(a, 'the alert exists');
  assert.equal(a.nurseSummary, 'Possible early congestion.');
  assert.deepEqual(a.suggestedActions, ['Call today', 'Ask about pillows']);
  assert.equal(a.readmissionRisk, 'high');
  assert.equal(a.model, 'qwen-test');
  assert.equal(a.ai, undefined, 'there is no nested `ai` object: the UI must not read one');
  assert.match(a.reasons[0], /patient: "slept in my recliner"/);
  aireview.setReviewer(null);
});
