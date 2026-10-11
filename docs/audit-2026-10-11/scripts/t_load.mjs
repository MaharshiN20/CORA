import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { startServer, stats, sleep } from './lab.mjs';

const out = console.log;
const rss = (pid) => { try { return Math.round(parseInt(execSync(`powershell -NoProfile -Command "(Get-Process -Id ${pid}).WorkingSet64"`).toString()) / 1048576); } catch { return null; } };
const srv = await startServer({ port: 3084, env: { LLM_PROVIDER: 'none' }, label: 'load' });
out('start RSS MB', rss(srv.child.pid));

// ---- grow the patient base ----
for (const N of [50, 200, 500]) {
  const have = (await srv.get('/api/patients')).json.length;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: N - have }, (_, i) => srv.post('/api/patients', { name: `Load P${have + i}`, age: 60 + (i % 30), language: ['en', 'es', 'vi'][i % 3], weights: Array.from({ length: 10 }, (_, d) => ({ ts: new Date(Date.now() - (10 - d) * 864e5).toISOString(), lb: 170 + (d % 3) })) })));
  const createMs = Date.now() - t0;
  const lat = { patients: [], alerts: [], one: [], impact: [] };
  for (let i = 0; i < 5; i++) {
    lat.patients.push((await srv.get('/api/patients')).ms);
    lat.alerts.push((await srv.get('/api/alerts')).ms);
    lat.one.push((await srv.get('/api/patients/p1')).ms);
    lat.impact.push((await srv.get('/api/insights/impact')).ms);
  }
  out(`N=${N} patients: create ${createMs}ms | GET /patients p50 ${stats(lat.patients).p50}ms max ${stats(lat.patients).max} | /alerts ${stats(lat.alerts).p50} | /patients/p1 ${stats(lat.one).p50} | /insights/impact ${stats(lat.impact).p50} | db ${(fs.statSync(srv.db).size / 1048576).toFixed(1)}MB | RSS ${rss(srv.child.pid)}MB`);
}

// ---- message storm: 1000 messages across patients, 40 concurrent ----
const ids = (await srv.get('/api/patients')).json.map((p) => p.id);
const lat = [];
let errs = 0;
const t0 = Date.now();
const work = Array.from({ length: 1000 }, (_, i) => async () => {
  const id = ids[i % ids.length];
  const r = await srv.post(`/api/patients/${id}/simulate`, { text: ['hola', 'weight 172', 'my feet are swollen', 'tengo chest pain', 'ok'][i % 5] });
  lat.push(r.ms);
  if (r.status !== 200) errs++;
});
const pool = 40;
let next = 0;
await Promise.all(Array.from({ length: pool }, async () => { while (next < work.length) await work[next++](); }));
out(`1000 messages, ${pool} concurrent: ${Date.now() - t0}ms total, per-request ${JSON.stringify(stats(lat))}, errors ${errs}, RSS ${rss(srv.child.pid)}MB, db ${(fs.statSync(srv.db).size / 1048576).toFixed(1)}MB`);
out('GET /patients after storm:', (await srv.get('/api/patients')).ms, 'ms ;  /alerts:', (await srv.get('/api/alerts')).ms, 'ms ; alerts', (await srv.get('/api/alerts')).json.length);

// ---- demo-clock jump with 500 patients ----
const a = await srv.post('/api/demo/advance', { hours: 72 });
out('advance 72h with 500 patients:', a.ms, 'ms', JSON.stringify(a.json?.jobs));
out('jobs in store after:', (await srv.get('/api/demo/jobs')).json.length);

// ---- kill -9 mid write storm; restart; is the DB valid? ----
out('\n=== crash durability ===');
const stormStop = { stop: false };
const storm = (async () => { let i = 0; while (!stormStop.stop) { await srv.post(`/api/patients/${ids[i++ % ids.length]}/simulate`, { text: 'weight 171' }).catch(() => {}); } })();
await sleep(1500);
const before = fs.statSync(srv.db).mtimeMs;
srv.kill9();
stormStop.stop = true;
await sleep(500);
let valid = false, size = 0;
try { const j = JSON.parse(fs.readFileSync(srv.db, 'utf8')); valid = true; size = j.patients.length; } catch (e) { out('DB unreadable after kill -9:', e.message); }
out('after kill -9: db valid =', valid, 'patients', size, '.bak exists', fs.existsSync(srv.db + '.bak'));
const srv2 = await startServer({ port: 3085, env: { LLM_PROVIDER: 'none', HEARTBRIDGE_DB: srv.db }, label: 'load2' });
const hp = await srv2.get('/api/patients');
out('restart on same DB: patients', hp.json?.length, '; startup log:', srv2.log.join('').split('\n').filter((l) => /store|corrupt|recover/i.test(l)).join(' | ') || '(clean)');
await srv2.stop();
