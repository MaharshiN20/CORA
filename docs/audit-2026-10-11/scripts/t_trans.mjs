import { startServer } from './lab.mjs';
const srv = await startServer({ port: 3083, env: { LLM_PROVIDER: 'lmstudio' }, label: 'trans' });
let n = 0;
const MSGS = ['Please bring your pill bottles to the clinic visit on Tuesday at 2 PM.', 'Your weight went up 3 lb. I will call you at 4:30 PM today.', 'Your potassium test is due this Friday.'];
for (const lang of ['ko', 'zh', 'ar', 'tl', 'ht', 'pt']) {
  for (const m of MSGS) {
    const id = (await srv.post('/api/patients', { name: `T ${++n}`, age: 70, language: lang })).json.id;
    const r = await srv.post(`/api/patients/${id}/message`, { text: m });
    console.log(`[${lang}] translated=${r.json.translated} ${r.ms}ms :: ${r.json.text.replace(/\s+/g, ' ').slice(0, 130)}`);
  }
}
await srv.stop();
