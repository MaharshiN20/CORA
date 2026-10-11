import { startServer, startProxy, stats, sleep } from './lab.mjs';

const proxy = await startProxy({ port: 1299 });
const srv = await startServer({ port: 3082, env: { LMSTUDIO_URL: proxy.url, LLM_PROVIDER: 'lmstudio' }, label: 'chaos2' });
const out = console.log;
let seq = 0;
const mk = async (lang, extra = {}) => (await srv.post('/api/patients', { name: `C2 ${lang} ${++seq}`, age: 71, language: lang, dryWeightLb: 165, weights: [{ ts: new Date(Date.now() - 864e5).toISOString(), lb: 165 }], ...extra })).json.id;
const sim = (id, b) => srv.post(`/api/patients/${id}/simulate`, b);

// ---------- (a) anatomy of a hung model: which calls, how long ----------
out('=== (a) HUNG model: a Korean emergency message. Time from send to reply, and the LLM calls behind it ===');
proxy.set({ mode: 'hang', delayMs: 0 });
proxy.state.log.length = 0;
const kid = await mk('ko');
const T0 = Date.now();
const p1 = sim(kid, { text: '가슴이 너무 아파요 숨을 못 쉬겠어요' });
// (b) same patient sends a second message 5 s later while the first is stuck
await sleep(5000);
const T1 = Date.now();
const p2 = sim(kid, { text: '도와주세요' });
const r1 = await p1;
const t1done = Date.now() - T0;
const r2 = await p2;
const t2done = Date.now() - T1;
out(`  msg#1 answered after ${(t1done / 1000).toFixed(1)} s ; msg#2 (sent at +5 s) answered ${(t2done / 1000).toFixed(1)} s after it was sent`);
out(`  LLM calls issued during msg#1+#2: ${proxy.state.log.length} at t(s) = ${proxy.state.log.map((c) => ((c.t - T0) / 1000).toFixed(0)).join(', ')}`);
out('  msg#1 reply:', JSON.stringify(r1.json?.map((x) => x.text.slice(0, 70))));
out('  msg#1 safety line "911" present in reply?', JSON.stringify(r1.json).includes('911'));
const kp = (await srv.get(`/api/patients/${kid}`)).json;
out('  alerts after 3+ minutes of a Korean "chest pain, cannot breathe":', (await srv.get('/api/alerts')).json.filter((a) => a.patientId === kid).length);
out('  checkin state:', kp.checkin.state, JSON.stringify(kp.checkin.answers));

// ---------- (c) translation: garbage gets cached and re-served? ----------
out('\n=== (c) translation cache poisoning: nurse message, garbage first, then a healthy model ===');
const msg = 'Your appointment is on Thursday at 3 PM. Please bring your medicine bottles.';
const kid2 = await mk('ko');
proxy.set({ mode: 'garbage', delayMs: 0 });
let r = await srv.post(`/api/patients/${kid2}/message`, { text: msg });
out('  while model returns garbage ->', JSON.stringify({ translated: r.json.translated, text: r.json.text.slice(0, 80) }));
proxy.set({ mode: 'pass', delayMs: 0 });
r = await srv.post(`/api/patients/${kid2}/message`, { text: msg });
out('  model healthy again, same message ->', JSON.stringify({ translated: r.json.translated, text: r.json.text.slice(0, 80) }));
const pm = (await srv.get(`/api/patients/${kid2}`)).json.messages.filter((m) => m.direction === 'out').map((m) => m.text.slice(0, 60));
out('  stored outbound texts:', JSON.stringify(pm));

// ---------- (d) translation fidelity of nurse messages ----------
out('\n=== (d) nurse message translation fidelity (model on, healthy). back-translated by the same model ===');
proxy.set({ mode: 'pass', delayMs: 0 });
const NURSE = [
  'Please bring your pill bottles to the clinic visit on Tuesday at 2 PM.',
  'Your weight went up 3 lb. Please do not take extra water pills; I will call you at 4:30 PM today.',
  'Remember to weigh yourself every morning before breakfast.',
  'Your potassium test is due this Friday.',
  'Call me if you feel more short of breath than yesterday. If it is severe, call 911.',
  'Your next dose of Entresto 49/51 mg is at 8 PM.',
];
const LANGS = ['es', 'vi', 'hi', 'zh', 'ko', 'ar', 'pt', 'tl', 'ht'];
const nums = (s) => (s.match(/\d+(?:[.,:/]\d+)*/g) ?? []);
const rows = [];
for (const lang of LANGS) {
  for (const m of NURSE) {
    const id = await mk(lang);
    const t0 = Date.now();
    const r = await srv.post(`/api/patients/${id}/message`, { text: m });
    const ms = Date.now() - t0;
    const tr = r.json?.text ?? '';
    const body = tr.replace(/^[^:：]*[:：]\s*/, ''); // drop "Nurse (team):" prefix
    // back-translate
    const bt = await (await fetch('http://localhost:1234/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'qwen2.5-7b-instruct', messages: [{ role: 'system', content: 'Translate to English. Output only the translation.' }, { role: 'user', content: body }], temperature: 0 }) })).json();
    const back = bt.choices[0].message.content;
    const missingNums = nums(m).filter((n) => !body.includes(n) && !tr.includes(n));
    const inject911 = !/911/.test(m) && /911/.test(tr);
    const dropped911 = /911/.test(m) && !/911/.test(tr);
    const ratio = body.length / m.length;
    rows.push({ lang, m, ms, translated: r.json?.translated, missingNums, inject911, dropped911, ratio, tr: body, back });
  }
}
let flagged = 0;
for (const r of rows) {
  const flags = [r.missingNums.length ? `MISSING-NUMBERS ${r.missingNums.join(',')}` : '', r.inject911 ? 'INJECTED-911' : '', r.dropped911 ? 'DROPPED-911' : '', r.ratio > 3 ? `LENGTH×${r.ratio.toFixed(1)}` : '', r.translated === false ? 'NOT-TRANSLATED' : ''].filter(Boolean);
  if (flags.length) flagged++;
  out(`  [${r.lang}] ${flags.length ? '⚠ ' + flags.join(' ') : 'ok'} (${r.ms} ms)\n      EN : ${r.m}\n      OUT: ${r.tr.slice(0, 140)}\n      BACK: ${r.back.slice(0, 160)}`);
}
out(`\n  flagged by mechanical checks: ${flagged}/${rows.length}`);
const byLang = {};
for (const r of rows) { const b = (byLang[r.lang] ??= { n: 0, bad: 0, ms: [] }); b.n++; b.ms.push(r.ms); if (r.missingNums.length || r.inject911 || r.dropped911 || r.ratio > 3) b.bad++; }
for (const [l, b] of Object.entries(byLang)) out(`  ${l}: ${b.bad}/${b.n} flagged, latency ${JSON.stringify(stats(b.ms))}`);
await srv.stop(); proxy.close();
