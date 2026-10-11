// Test lab for HeartBridge: boots the REAL server on a throwaway DB, talks to it over HTTP,
// and (optionally) puts a chaos proxy between the app and LM Studio.
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const BACKEND = 'D:/Personal-Projects/HackGT/backend';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startServer({ port = 3071, env = {}, label = 'srv' } = {}) {
  const db = path.join(os.tmpdir(), `heartbridge-lab-${label}-${process.pid}-${Date.now()}.json`);
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: BACKEND,
    env: {
      ...process.env,
      PORT: String(port),
      HEARTBRIDGE_DB: db,
      TELEGRAM_BOT_TOKEN: '',
      GEMINI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      LLM_PROVIDER: 'lmstudio',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch {}
    await sleep(200);
  }
  const token = env.API_TOKEN;
  const call = (method, p, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const t0 = performance.now();
      const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
      const req = http.request(
        { host: '127.0.0.1', port, path: p, method, headers: { ...(payload !== undefined && { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...(token && { Authorization: `Bearer ${token}` }), ...headers } },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = JSON.parse(text); } catch {}
            resolve({ status: res.statusCode, ms: Math.round(performance.now() - t0), json, text, headers: { get: (k) => res.headers[k.toLowerCase()] ?? null } });
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(0); // no client-side timeout: we are measuring the server
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  return {
    base, db, log, call,
    get: (p, h) => call('GET', p, undefined, h),
    post: (p, b, h) => call('POST', p, b ?? {}, h),
    patch: (p, b) => call('PATCH', p, b),
    async stop() {
      child.kill();
      await sleep(300);
      for (const f of [db, `${db}.bak`, `${db}.corrupt`]) try { fs.rmSync(f, { force: true }); } catch {}
    },
    kill9() { child.kill('SIGKILL'); },
    child,
  };
}

// Chaos proxy in front of LM Studio. Modes: pass | slow | garbage | error500 | empty | truncated | hang
export async function startProxy({ port = 1299, target = 'http://localhost:1234' } = {}) {
  const state = { mode: 'pass', delayMs: 0, calls: 0, log: [] };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (req.url === '/__mode') {
      Object.assign(state, JSON.parse(body.toString() || '{}'));
      res.end('ok');
      return;
    }
    state.calls++;
    const isChat = req.url.includes('/chat/completions');
    if (isChat) state.log.push({ t: Date.now(), mode: state.mode });
    if (isChat && state.mode === 'hang') return; // never answers
    if (isChat && state.delayMs) await sleep(state.delayMs);
    if (isChat && state.mode === 'error500') { res.writeHead(500); res.end('boom'); return; }
    if (isChat && state.mode === 'empty') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '' } }] })); return; }
    if (isChat && state.mode === 'garbage') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'Sure! Here is some prose with no JSON at all. {not valid' } }] })); return; }
    if (isChat && state.mode === 'prose') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'I cannot help with that.' } }] })); return; }
    try {
      const up = await fetch(target + req.url, { method: req.method, headers: { 'Content-Type': 'application/json' }, body: req.method === 'GET' ? undefined : body });
      const text = await up.text();
      if (isChat && state.mode === 'truncated') {
        try { const j = JSON.parse(text); const c = j.choices[0].message.content; j.choices[0].message.content = c.slice(0, Math.floor(c.length / 2)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); return; } catch {}
      }
      res.writeHead(up.status, { 'Content-Type': 'application/json' });
      res.end(text);
    } catch (e) { res.writeHead(502); res.end(String(e)); }
  });
  await new Promise((r) => server.listen(port, r));
  return {
    url: `http://localhost:${port}`,
    state,
    set: (m) => Object.assign(state, m),
    close: () => server.close(),
  };
}

export const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null; };
export const stats = (xs) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), max: Math.max(...xs), min: Math.min(...xs) });
