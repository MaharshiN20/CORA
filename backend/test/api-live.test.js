// Integration 1 fixes: live risk on every read; inbound English translation off the reply path.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-apilive-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, agent, llm, server, base;
const realFetch = globalThis.fetch;
before(async () => {
  store = await import('../src/store.js');
  agent = await import('../src/core/agent.js');
  llm = await import('../src/core/llm/index.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  store.reset();
});
after(() => server?.close());

test('patient reads carry the live Risk v2 (Maria\'s weight trend shows before any check-in)', async () => {
  const p = await (await realFetch(`${base}/api/patients/p1`)).json();
  assert.ok(p.riskDynamic, 'riskDynamic present');
  assert.ok(p.riskDynamic.factors.some((f) => /Weight up/.test(f.label)));
  assert.ok(p.riskBaseline.factors.length > 0);
  const list = await (await realFetch(`${base}/api/patients`)).json();
  assert.ok(list.every((x) => x.riskDynamic && x.riskBaseline));
});

test('non-English replies do not wait for the English translation; it fills in afterwards', async () => {
  process.env.LLM_PROVIDER = 'lmstudio';
  let release;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }] }));
    if (u.endsWith('/v1/chat/completions')) {
      const sys = JSON.parse(opts.body).messages[0].content;
      if (sys.startsWith('Translate into English')) {
        await new Promise((r) => (release = r)); // translation is slow
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Hello, good morning' } }] }));
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }));
    }
    return realFetch(url, opts);
  };
  try {
    await llm.detect({ force: true });
    const replies = await agent.handleInbound({ patientId: 'p1', text: 'hola buenos días' }); // resolves while translation hangs
    assert.ok(replies.length > 0);
    const inbound = store.listMessages('p1').filter((m) => m.direction === 'in').at(-1);
    assert.equal(inbound.textEn, undefined);
    release();
    await agent.flushTranslations();
    assert.equal(store.listMessages('p1').filter((m) => m.direction === 'in').at(-1).textEn, 'Hello, good morning');
  } finally {
    globalThis.fetch = realFetch;
    process.env.LLM_PROVIDER = 'none';
  }
});
