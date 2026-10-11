import { startServer, startProxy } from './lab.mjs';
const proxy = await startProxy({ port: 1299 });
const srv = await startServer({ port: 3080, env: { LMSTUDIO_URL: proxy.url, LLM_PROVIDER: 'lmstudio' }, label: 'v2' });
const out = console.log;
let seq = 0;
const mk = async (lang) => (await srv.post('/api/patients', { name: `V2 ${lang} ${++seq}`, age: 71, language: lang, dryWeightLb: 165, weights: [{ ts: new Date(Date.now() - 864e5).toISOString(), lb: 165 }] })).json.id;

out('=== (b) model-raised RED: what does the PATIENT actually receive? (ALL replies) ===');
for (const [lang, text] of [['en', 'I feel like I am dying'], ['en', 'there is a crushing pain in the middle of my chest'], ['es', 'se me va a salir el corazón del pecho, me duele muchísimo'], ['vi', 'Tôi cảm thấy sắp chết']]) {
  const id = await mk(lang);
  const r = await srv.post(`/api/patients/${id}/simulate`, { text });
  const p = (await srv.get(`/api/patients/${id}`)).json;
  const reds = (await srv.get('/api/alerts')).json.filter((a) => a.patientId === id);
  out(`\n[${lang}] ${text}`);
  out(`  replies returned to channel (${r.json.length}):`);
  r.json.forEach((x, i) => out(`    #${i} urgent=${!!x.urgent} ${JSON.stringify(x.text.slice(0, 110))}`));
  out(`  stored outbound messages: ${p.messages.filter((m) => m.direction === 'out').map((m) => (m.text.includes('911') ? '[has 911]' : '[no 911]')).join(' ')}`);
  out(`  alerts: ${reds.map((a) => a.tier + ' ' + a.title.slice(0, 60)).join(' | ') || 'none'}`);
  out(`  checkin state=${p.checkin.state} lastTier=${p.lastTier}`);
}

out('\n=== (c) zh check-in: what did the model return and what was kept? (parse_trace) ===');
const zid = await mk('zh');
await srv.post(`/api/patients/${zid}/simulate`, { buttonData: 'cmd:checkin' });
for (const m of ['没有胸痛，也没有晕倒', '昨晚要垫三个枕头才能睡，脚踝肿得厉害', '利尿药已经吃了']) {
  await srv.post(`/api/patients/${zid}/simulate`, { text: m });
}
const zp = (await srv.get(`/api/patients/${zid}`)).json;
for (const e of zp.audit.filter((e) => e.type === 'parse_trace')) {
  const d = e.data;
  out(`\n  text=${JSON.stringify(d.text ?? d.button)} step=${d.step}`);
  out(`    rules: ${JSON.stringify(d.rules)}`);
  out(`    llm.fields: ${JSON.stringify(d.llm?.fields)}  dropped=${JSON.stringify(d.llm?.dropped)} unverified=${JSON.stringify(d.llm?.unverified)} ms=${d.llm?.ms} timedOut=${d.llm?.timedOut}`);
}
out('\n  state after:', zp.checkin.state, JSON.stringify(zp.checkin.answers));
out('  messages the patient got:');
zp.messages.filter((m) => m.direction === 'out').forEach((m) => out('    -', JSON.stringify(m.text.slice(0, 100)), (m.buttons ? ' [buttons]' : '')));

out('\n=== (d) does the same patient get a workable path by tapping buttons? ===');
const bid = await mk('zh');
await srv.post(`/api/patients/${bid}/simulate`, { buttonData: 'cmd:checkin' });
for (const b of ['ci:rf:none', 'ci:breath:normal']) await srv.post(`/api/patients/${bid}/simulate`, { buttonData: b });
out('  after rf:none, breath:normal ->', (await srv.get(`/api/patients/${bid}`)).json.checkin.state);

await srv.stop(); proxy.close();
