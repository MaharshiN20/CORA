// Scores a batch through the LIVE path: the real server on a throwaway database, one fresh patient per
// message, POST /api/patients/:id/simulate, exactly what the website's phone does.
//   node docs/independent-eval/live.mjs evals/independent-2026-10-10.jsonl [--llm=lmstudio] [--quiet] [--json=out.json] [--backend=<path>] [--port=3093]
// "Fired" = the reply was the urgent 911 message. Without --llm the server runs with LLM_PROVIDER=none.
// A caregiver-voiced row (style caregiver, or the "unresponsive" category) is sent with role=caregiver.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRows, summarise, render } from './score.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const quiet = args.includes('--quiet');
const llm = opt('llm') ?? 'none';
const port = Number(opt('port') ?? 3093);
const backend = path.resolve(opt('backend') ?? path.join(HERE, '../../backend'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = path.join(os.tmpdir(), `heartbridge-indep-live-${process.pid}.json`);
const child = spawn(process.execPath, ['src/index.js'], {
  cwd: backend,
  env: { ...process.env, PORT: String(port), HEARTBRIDGE_DB: db, TELEGRAM_BOT_TOKEN: '', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', NURSE_CHAT_ID: '', LLM_PROVIDER: llm },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = [];
child.stdout.on('data', (d) => log.push(String(d)));
child.stderr.on('data', (d) => log.push(String(d)));
const base = `http://127.0.0.1:${port}`;
const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};

try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await sleep(200);
  }
  if (llm !== 'none') {
    // The chain probes in the background; wait until it reports a model (or give up and say so).
    for (let i = 0; i < 40; i++) {
      if ((await call('GET', '/api/health')).json?.llm?.available) break;
      await sleep(500);
    }
  }
  const health = (await call('GET', '/api/health')).json;
  console.error(`server up, llm: ${JSON.stringify(health?.llm)}`);

  // --every=3 scores every third row: the file is sorted by language, category and text, so that is
  // an even sample (a local model answers a message in about 15 s; the whole batch takes hours).
  const every = Number(opt('every') ?? 1);
  const rows = loadRows(file).filter((r) => r.label !== 'exclude').filter((_, i) => i % every === 0);
  const fired = new Map();
  const info = new Map();
  let done = 0;
  async function one(r) {
    const caregiver = r.style === 'caregiver' || r.category === 'unresponsive';
    const now = Date.parse(health.now);
    const p = await call('POST', '/api/patients', {
      name: `Indep ${r.id}`,
      age: 74,
      language: r.lang,
      dryWeightLb: 170,
      weights: [3, 2, 1].map((d) => ({ ts: new Date(now - d * 86_400_000).toISOString(), lb: 170 })),
      caregiver: { name: 'Sam Family', relation: 'child', language: r.lang },
    });
    if (p.status !== 201) throw new Error(`create ${r.id}: ${p.status} ${p.text.slice(0, 200)}`);
    const t0 = Date.now();
    const res = await call('POST', `/api/patients/${p.json.id}/simulate`, { text: r.text, ...(caregiver && { role: 'caregiver' }) });
    const ms = Date.now() - t0;
    const urgent = res.status === 200 && Array.isArray(res.json) && res.json.some((x) => x.urgent);
    fired.set(r.id, urgent);
    const detail = (await call('GET', `/api/patients/${p.json.id}`)).json;
    info.set(r.id, {
      status: res.status,
      ms,
      replies: Array.isArray(res.json) ? res.json.length : 0,
      red: (detail?.alerts ?? []).filter((a) => a.tier === 'RED').length,
      viaModel: (detail?.audit ?? []).some((a) => a.type === 'llm_parse'),
      reply: Array.isArray(res.json) ? (res.json[0]?.textEn ?? res.json[0]?.text ?? '').slice(0, 90) : res.text.slice(0, 90),
    });
    if (++done % 100 === 0) console.error(`  ${done}/${rows.length}`);
  }
  // With a model on, one message at a time: the patient-facing parse has a hard deadline, and queueing
  // several requests on one local GPU would turn that deadline into misses that are not the rules' fault.
  const width = llm === 'none' ? 6 : 1;
  const queue = [...rows];
  await Promise.all(Array.from({ length: width }, async () => { while (queue.length) await one(queue.shift()); }));

  const s = summarise(rows, fired);
  const all = [...info.values()];
  const not200 = all.filter((x) => x.status !== 200).length;
  const noReply = all.filter((x) => x.status === 200 && x.replies === 0).length;
  // "Fired" must mean the whole thing happened: the 911 reply AND exactly one RED alert on the worklist.
  const mismatch = rows.filter((r) => fired.get(r.id) !== (info.get(r.id).red > 0) || info.get(r.id).red > 1).map((r) => r.id);
  const lat = all.map((x) => x.ms).sort((a, b) => a - b);
  const breaker = log.join('').split('\n').filter((l) => /failures in a row/.test(l)).length;
  console.log(render(`Live path (POST /simulate), LLM_PROVIDER=${llm}: ${path.basename(file)}`, s, { quiet, detail: (r) => `  → "${info.get(r.id).reply}"${info.get(r.id).viaModel ? ' (model)' : ''}` }));
  console.log(`Non-200 answers: ${not200}. Messages with no reply: ${noReply}. 911 reply without exactly one RED alert (or the reverse): ${mismatch.length}${mismatch.length ? ` (${mismatch.slice(0, 10).join(', ')})` : ''}.`);
  console.log(`Latency: p50 ${lat[Math.floor(lat.length / 2)]} ms, p95 ${lat[Math.floor(lat.length * 0.95)]} ms, max ${lat.at(-1)} ms.`);
  if (llm !== 'none') console.log(`Emergencies the model (not the rules) caught: ${rows.filter((r) => r.label === 'emergency' && info.get(r.id).viaModel).length}. False alarms the model raised: ${rows.filter((r) => r.label === 'calm' && fired.get(r.id) && info.get(r.id).viaModel).length}. Times the circuit breaker opened: ${breaker}.`);
  const json = opt('json');
  if (json) fs.writeFileSync(json, JSON.stringify({ file, llm, backend, summary: { ...s, misses: s.misses.map((r) => r.id), falseAlarms: s.falseAlarms.map((r) => r.id) }, fired: Object.fromEntries(fired), info: Object.fromEntries(info), not200, noReply, mismatch, breaker }, null, 1));
} finally {
  child.kill();
  await sleep(300);
  for (const f of [db, `${db}.bak`]) try { fs.rmSync(f, { force: true }); } catch {}
}
