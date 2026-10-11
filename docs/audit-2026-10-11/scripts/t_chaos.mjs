import { startServer, startProxy, stats, sleep } from './lab.mjs';

const proxy = await startProxy({ port: 1299 });
const srv = await startServer({ port: 3081, env: { LMSTUDIO_URL: proxy.url, LLM_PROVIDER: 'lmstudio' }, label: 'chaos' });
const out = console.log;
let seq = 0;
const mk = async (lang, extra = {}) => (await srv.post('/api/patients', { name: `Chaos ${lang} ${++seq}`, age: 71, language: lang, dryWeightLb: 165, weights: [{ ts: new Date(Date.now() - 864e5).toISOString(), lb: 165 }], ...extra })).json.id;
const sim = (id, b) => srv.post(`/api/patients/${id}/simulate`, b);
const reds = async (id) => (await srv.get('/api/alerts')).json.filter((a) => a.patientId === id && a.tier === 'RED').length;

const MODES = [
  { mode: 'pass', delayMs: 0, name: 'healthy model' },
  { mode: 'pass', delayMs: 3000, name: 'slow model (+3 s per call)' },
  { mode: 'pass', delayMs: 7000, name: 'very slow model (+7 s per call)' },
  { mode: 'hang', delayMs: 0, name: 'HUNG model (never answers)' },
  { mode: 'garbage', delayMs: 0, name: 'garbage output (prose + broken JSON)' },
  { mode: 'prose', delayMs: 0, name: 'refusal prose "I cannot help with that."' },
  { mode: 'empty', delayMs: 0, name: 'empty content' },
  { mode: 'error500', delayMs: 0, name: 'HTTP 500 from model' },
  { mode: 'truncated', delayMs: 0, name: 'half-truncated output' },
];
const table = [];
for (const M of MODES) {
  proxy.set({ mode: M.mode, delayMs: M.delayMs });
  out(`\n############ ${M.name} ############`);
  const row = { mode: M.name };

  // 1. vi patient: unprompted emergency that ONLY the model can catch ("dad collapsed" is not in any list, use confusion phrase that rules also catch? use model-only phrase)
  let id = await mk('zh');
  let t0 = Date.now();
  let r = await sim(id, { text: '我妈妈糊涂了，不认识人了' }); // rules DO have zh confusion list, so should be RED regardless of model
  row.zhEmergency = { ms: Date.now() - t0, red: (await reds(id)) > 0, urgent: !!r.json?.[0]?.urgent };
  out('  zh confusion (rules cover):', JSON.stringify(row.zhEmergency));

  // 2. Korean patient (no rules at all): emergency text only the model could understand
  id = await mk('ko');
  t0 = Date.now();
  r = await sim(id, { text: '가슴이 너무 아파요 숨을 못 쉬겠어요' });
  row.koEmergency = { ms: Date.now() - t0, red: (await reds(id)) > 0, urgent: !!r.json?.[0]?.urgent, reply: (r.json?.[0]?.text ?? '').slice(0, 50) };
  out('  ko chest pain (no rules for ko):', JSON.stringify(row.koEmergency));

  // 3. es check-in free text
  id = await mk('es');
  await sim(id, { buttonData: 'cmd:checkin' });
  t0 = Date.now();
  r = await sim(id, { text: 'no tengo dolor de pecho ni nada raro' });
  const ms1 = Date.now() - t0;
  t0 = Date.now();
  r = await sim(id, { text: 'me pesé y salió 168 libras, los pies están muy hinchados' });
  const p = (await srv.get(`/api/patients/${id}`)).json;
  row.esCheckin = { ms: [ms1, Date.now() - t0], answers: p.checkin.answers };
  out('  es check-in free text:', JSON.stringify(row.esCheckin));

  // 4. companion question
  id = await mk('en');
  t0 = Date.now();
  r = await sim(id, { text: 'Can I eat canned soup?' });
  row.companion = { ms: Date.now() - t0, text: (r.json?.[0]?.text ?? '').slice(0, 60) };
  out('  companion:', JSON.stringify(row.companion));

  // 5. nurse message to a Vietnamese patient (translate)
  id = await mk('ko');
  t0 = Date.now();
  r = await srv.post(`/api/patients/${id}/message`, { text: 'Please bring your pill bottles to the clinic visit on Tuesday at 2 PM.' });
  row.nurseMsg = { ms: Date.now() - t0, translated: r.json?.translated, text: (r.json?.text ?? '').slice(0, 70) };
  out('  nurse->ko message:', JSON.stringify(row.nurseMsg));

  // 6. Start a check-in for a ko patient (translated prompts)
  id = await mk('ko');
  t0 = Date.now();
  r = await srv.post(`/api/patients/${id}/checkin`);
  row.startCheckinKo = { ms: Date.now() - t0, status: r.status };
  out('  start check-in (ko):', JSON.stringify(row.startCheckinKo));
  table.push(row);
}

proxy.set({ mode: 'pass', delayMs: 0 });
out('\n=== chaos summary: patient-visible latency (ms) per scenario ===');
out('mode'.padEnd(46), 'zh-911'.padStart(8), 'ko-911'.padStart(8), 'es-chk'.padStart(10), 'compan'.padStart(8), 'nurseMsg'.padStart(9), 'ko-start'.padStart(9));
for (const r of table) out(r.mode.padEnd(46), String(r.zhEmergency.ms).padStart(8), (String(r.koEmergency.ms) + (r.koEmergency.red ? '✔' : '✘')).padStart(8), String(r.esCheckin.ms[1]).padStart(10), String(r.companion.ms).padStart(8), String(r.nurseMsg.ms).padStart(9), String(r.startCheckinKo.ms).padStart(9));
out('\nzh/ko emergencies detected (RED) per mode:');
for (const r of table) out('  ', r.mode.padEnd(46), 'zh:', r.zhEmergency.red ? 'RED' : 'MISSED', ' ko:', r.koEmergency.red ? 'RED' : 'MISSED', ' ko reply:', JSON.stringify(r.koEmergency.reply));
const errs = srv.log.join('').split('\n').filter((l) => /error|failed|timed|unhandled|cool/i.test(l));
out(`\nserver log lines mentioning error/failed/timeout/cooldown: ${errs.length}`);
const uniq = [...new Set(errs.map((l) => l.replace(/\d+/g, 'N').slice(0, 140)))];
for (const l of uniq.slice(0, 15)) out('  ', l);
await srv.stop(); proxy.close();
