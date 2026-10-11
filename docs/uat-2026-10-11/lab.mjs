// Shared harness for the end-to-end walkthrough: boots the REAL server on a throwaway DB (English
// patients, no model: deterministic), and gives scenarios a tiny DSL.
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backend');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function boot({ port = 3091, env = {} } = {}) {
  const db = path.join(os.tmpdir(), `heartbridge-uat-${process.pid}-${port}.json`);
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: BACKEND,
    env: { ...process.env, PORT: String(port), HEARTBRIDGE_DB: db, TELEGRAM_BOT_TOKEN: '', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', LLM_PROVIDER: 'none', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {}
    await sleep(200);
  }
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
  return {
    base, db, log, child,
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b ?? {}),
    patch: (p, b) => call('PATCH', p, b ?? {}),
    async stop() {
      child.kill();
      await sleep(300);
      for (const f of [db, `${db}.bak`]) try { fs.rmSync(f, { force: true }); } catch {}
    },
  };
}

const results = [];
export function makeRunner(srv) {
  let n = 0;
  // "Now" is the server's demo clock (scenarios move it), not the wall clock.
  let base = Date.now();
  const refresh = async () => { base = Date.parse((await srv.get('/api/demo/clock')).json.now); };
  const day = (d) => new Date(base - d * 86_400_000).toISOString();
  // A patient with a weight history (lb, oldest first, one per day ending yesterday).
  const mk = async (name, { weights = [170, 170.4, 170.2, 170.5], dry, language = 'en', caregiver, prescriptions, meds, age = 70, profile } = {}) => {
    await refresh();
    const r = await srv.post('/api/patients', {
      name: `${name} U${++n}`,
      age,
      language,
      weights: weights.map((lb, i) => ({ ts: day(weights.length - i), lb })),
      dryWeightLb: dry ?? weights[0],
      caregiver,
      prescriptions,
      meds,
      profile,
    });
    if (r.status !== 201) throw new Error(`could not create ${name}: ${r.status} ${r.text}`);
    return r.json.id;
  };
  const say = async (id, input, extra = {}) => {
    const body = typeof input === 'string' ? { text: input } : input;
    const r = await srv.post(`/api/patients/${id}/simulate`, { ...body, ...extra });
    if (r.status !== 200) throw new Error(`simulate ${r.status}: ${r.text}`);
    return r.json;
  };
  const tap = (id, data, extra) => say(id, { buttonData: data }, extra);
  const texts = (replies) => replies.map((x) => x.text).join(' ⏎ ');
  const buttons = (replies) => replies.flatMap((x) => (x.buttons ?? []).flat().map((b) => b.data));
  const patient = async (id) => (await srv.get(`/api/patients/${id}`)).json;
  const alerts = async (id) => (await srv.get('/api/alerts')).json.filter((a) => a.patientId === id);
  const open = async (id) => (await alerts(id)).filter((a) => a.status !== 'resolved');
  const tiers = async (id) => (await alerts(id)).map((a) => `${a.tier}:${a.kind ?? 'triage'}`);

  const scenario = async (name, fn) => {
    const checks = [];
    const t = { log: [] };
    const ok = (what, cond, detail = '') => {
      checks.push({ what, pass: !!cond, detail: cond ? '' : String(detail).slice(0, 400) });
      return !!cond;
    };
    try {
      await fn({ ok, note: (s) => t.log.push(s) });
    } catch (err) {
      checks.push({ what: 'scenario ran to the end', pass: false, detail: String(err.stack ?? err).slice(0, 500) });
    }
    results.push({ name, checks, log: t.log });
    const bad = checks.filter((c) => !c.pass);
    console.log(`${bad.length ? '✗' : '✓'} ${name}  (${checks.length - bad.length}/${checks.length})`);
    for (const c of bad) console.log(`    ✗ ${c.what}${c.detail ? `\n        ${c.detail}` : ''}`);
  };
  return { mk, say, tap, texts, buttons, patient, alerts, open, tiers, scenario, day, refresh };
}

export function summary() {
  const all = results.flatMap((r) => r.checks);
  const bad = all.filter((c) => !c.pass);
  console.log(`\n${results.length} scenarios, ${all.length} checks, ${bad.length} failed`);
  return { results, failed: bad.length };
}
