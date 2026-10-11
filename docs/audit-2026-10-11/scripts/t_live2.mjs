import { startServer, startProxy, stats } from './lab.mjs';

const proxy = await startProxy({ port: 1299 });
const srv = await startServer({ port: 3078, env: { LMSTUDIO_URL: proxy.url, LLM_PROVIDER: 'lmstudio' }, label: 'live2' });
const none = await startServer({ port: 3079, env: { LLM_PROVIDER: 'none' }, label: 'live2n' });
const out = console.log;
let seq = 0;
const mk = async (s, lang) => (await s.post('/api/patients', { name: `Fresh ${lang} ${++seq}`, age: 71, language: lang, dryWeightLb: 165, weights: [{ ts: new Date(Date.now() - 864e5).toISOString(), lb: 165 }, { ts: new Date(Date.now() - 2 * 864e5).toISOString(), lb: 165 }] })).json.id;
const sim = (s, id, b) => s.post(`/api/patients/${id}/simulate`, b);
const pat = async (s, id) => (await s.get(`/api/patients/${id}`)).json;
const reds = async (s, id) => (await s.get('/api/alerts')).json.filter((a) => a.patientId === id && a.tier === 'RED' && (a.kind ?? 'triage') === 'triage');

// ============ S3 (idle, fresh patient per message): unprompted emergencies ============
out('=== S3 clean: idle patient, ONE emergency message each. columns: MODEL-ON | RULES-ONLY');
const EM = [
  // [lang, text, what it means]
  ['es', 'se me va a salir el corazón del pecho, me duele muchísimo', 'severe chest pain'],
  ['es', 'mi esposo se cayó y no responde', 'husband collapsed, unresponsive'],
  ['es', 'siento que me muero', 'I feel like I am dying'],
  ['es', 'me falta el aire y tengo los labios morados', 'short of breath, purple lips'],
  ['es', 'tengo un dolor horrible en el pecho que me llega hasta el brazo izquierdo', 'chest pain to left arm'],
  ['es', 'mi mamá no despierta', 'mom will not wake up'],
  ['en', 'I think I am having a heart attack', ''],
  ['en', 'there is a crushing pain in the middle of my chest', ''],
  ['en', 'my husband collapsed and is not responding', ''],
  ['en', 'I feel like I am dying', ''],
  ['en', 'I cannot finish a sentence without gasping', ''],
  ['en', 'Dad passed out in the kitchen', ''],
  ['vi', 'Mẹ tôi có vẻ lú lẫn, không biết mình đang ở đâu', 'confusion'],
  ['vi', 'Tôi bị tức ngực dữ dội từ sáng, khó thở', 'chest tightness + breathless'],
  ['vi', 'Ba tôi ngã xuống và không trả lời', 'dad collapsed, no answer'],
  ['vi', 'Tôi cảm thấy sắp chết', 'I feel I am dying'],
  ['hi', 'पापा बेहोश हो गए हैं', 'dad fainted'],
  ['hi', 'सीने में तेज़ दर्द हो रहा है', 'sharp chest pain'],
  ['hi', 'मेरी पत्नी गिर गई और जवाब नहीं दे रही', 'wife collapsed no response'],
  ['hi', 'मुझे लगता है मैं मरने वाला हूँ', 'I feel I am dying'],
  ['zh', '我妈妈糊涂了，不认识人了', 'confusion'],
  ['zh', '我胸口很痛，喘不过气', 'chest pain + cannot breathe'],
  ['zh', '我爸爸倒在地上叫不醒', 'dad collapsed, cannot be woken'],
  ['zh', '我觉得我要死了', 'I feel I am dying'],
];
const s3 = { on: [], off: [] };
let missOn = 0, missOff = 0;
for (const [lang, text, gloss] of EM) {
  const row = [];
  for (const [label, s] of [['on', srv], ['off', none]]) {
    const id = await mk(s, lang);
    const t0 = Date.now();
    const r = await sim(s, id, { text });
    const ms = Date.now() - t0;
    s3[label].push(ms);
    const red = (await reds(s, id)).length > 0;
    const urgent = !!r.json?.[0]?.urgent;
    const reply = (r.json?.[0]?.text ?? '').replace(/\s+/g, ' ').slice(0, 55);
    row.push({ red, urgent, ms, reply });
    if (!red) label === 'on' ? missOn++ : missOff++;
  }
  const f = (x) => `${x.red ? 'RED ✔' : 'NO ALERT ✘'} ${x.urgent ? 'urgent' : 'calm  '} ${String(x.ms).padStart(4)}ms`;
  out(`[${lang}] ${text}${gloss ? '   (' + gloss + ')' : ''}\n      MODEL-ON : ${f(row[0])}  "${row[0].reply}"\n      RULES-ONLY: ${f(row[1])}  "${row[1].reply}"`);
}
out(`MISSED emergencies (no RED alert): model-on ${missOn}/${EM.length}; rules-only ${missOff}/${EM.length}`);
out('latency model-on', JSON.stringify(stats(s3.on)), ' rules-only', JSON.stringify(stats(s3.off)));

// ============ S2 clean: per-language free-text check-in ============
out('\n=== S2 clean: free-text check-in, fresh patient per language (MODEL-ON) ===');
const FLOW = {
  es: ['no tengo dolor de pecho ni nada raro', 'me pesé y salió 168 libras', 'respiro bien, solo me canso un poquito al caminar', 'dormí en el sillón anoche, y los pies como globos', 'sí me tomé la pastilla del agua'],
  vi: ['Không, tôi không bị đau ngực hay ngất xỉu', 'Sáng nay cân được 75 kg', 'Tôi thở bình thường', 'Đêm qua tôi phải ngồi ngủ, chân sưng to hơn', 'Tôi đã uống thuốc lợi tiểu rồi'],
  hi: ['नहीं, सीने में दर्द या बेहोशी नहीं है', 'आज वज़न 160 पाउंड है', 'सांस सामान्य है', 'रात को सांस फूल रही थी, पैर सूजे हुए हैं', 'हाँ, पानी की गोली ले ली'],
  zh: ['没有胸痛，也没有晕倒', '今天体重170磅', '呼吸还好，爬楼梯有点喘', '昨晚要垫三个枕头才能睡，脚踝肿得厉害', '利尿药已经吃了'],
};
for (const [lang, msgs] of Object.entries(FLOW)) {
  const id = await mk(srv, lang);
  await sim(srv, id, { buttonData: 'cmd:checkin' });
  out(`-- ${lang}`);
  for (const m of msgs) {
    const calls0 = proxy.state.calls;
    const t0 = Date.now();
    await sim(srv, id, { text: m });
    const ms = Date.now() - t0;
    const p = await pat(srv, id);
    out(`   ${String(ms).padStart(5)}ms llmCalls=${proxy.state.calls - calls0} step=${p.checkin?.state} answers=${JSON.stringify(p.checkin?.answers)}  <- ${m}`);
  }
  const p = await pat(srv, id);
  out(`   => finished check-ins: ${p.checkins?.length}, lastTier=${p.lastTier}, state=${p.checkin?.state}, alerts=${(await srv.get('/api/alerts')).json.filter((a) => a.patientId === id).map((a) => a.tier + ':' + a.title.slice(0, 50)).join(' | ')}`);
}

out('\nproxy chat calls total:', proxy.state.calls);
const errLines = srv.log.join('').split('\n').filter((l) => /error|failed|timed|unhandled|warn/i.test(l));
out('SERVER LOG error/warn lines:', errLines.length);
for (const l of errLines.slice(0, 20)) out('  ', l.slice(0, 220));
await srv.stop(); await none.stop(); proxy.close();
