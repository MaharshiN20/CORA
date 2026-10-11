import { startServer } from './lab.mjs';

const srv = await startServer({ port: 3073, env: { LLM_PROVIDER: 'none' }, label: 'csrf' });
const before = (await srv.get('/api/patients')).json.length;
console.log('patients before:', before);

// What a malicious web page can do with NO preflight: a plain HTML <form method=POST> (urlencoded / multipart / text/plain).
const form = (p, body, type = 'application/x-www-form-urlencoded') => srv.call('POST', p, body, { 'Content-Type': type, Origin: 'https://evil.example', Referer: 'https://evil.example/' });

let r = await form('/api/patients', 'name=Created+By+Evil+Site&age=70');
console.log('form POST /api/patients ->', r.status, r.json?.name);
r = await form('/api/patients/p1/simulate', 'text=I+have+chest+pain&role=patient');
console.log('form POST simulate (fake a patient message) ->', r.status, r.text.slice(0, 100));
r = await form('/api/patients/p1/unlink', 'role=patient');
console.log('form POST unlink ->', r.status, r.text.slice(0, 60));
r = await form('/api/patients/p1/message', 'text=Stop+taking+your+meds&from=Nurse');
console.log('form POST nurse->patient message ->', r.status, r.text.slice(0, 100));
r = await form('/api/patients/p1/checkin', '');
console.log('form POST start check-in ->', r.status);
r = await form('/api/demo/advance', 'hours=720');
console.log('form POST demo/advance 720h ->', r.status, r.text.slice(0, 80));
r = await form('/api/reset', '');
console.log('form POST /api/reset (wipes DB) ->', r.status, r.text.slice(0, 60));
r = await form('/api/insights/cohort/regenerate', 'size=500');
console.log('form POST cohort regenerate ->', r.status);
r = await form('/api/patients/p1/message', '{"text":"x"}', 'text/plain');
console.log('text/plain trick (JSON body) ->', r.status);
// DNS-rebinding style: Host header of an attacker domain
r = await srv.call('GET', '/api/patients', undefined, { Host: 'evil.example' });
console.log('GET with Host: evil.example (DNS rebinding) ->', r.status, '(patients readable:', Array.isArray(r.json), ')');
// CORS preflight from evil origin for PATCH
const pre = await fetch(`${srv.base}/api/alerts/x`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'content-type' } });
console.log('CORS preflight from evil origin: allow-origin =', pre.headers.get('access-control-allow-origin'));
const get = await srv.call('GET', '/api/patients', undefined, { Origin: 'https://evil.example' });
console.log('GET /api/patients with Origin evil: allow-origin =', get.headers.get('access-control-allow-origin'), '(a browser page on evil.example could READ patient data)');
console.log('patients after:', (await srv.get('/api/patients')).json?.length);
await srv.stop();

// Same battery with API_TOKEN set
const s2 = await startServer({ port: 3074, env: { LLM_PROVIDER: 'none', API_TOKEN: 'secret-token' }, label: 'csrf2' });
const noTok = (p, body, type = 'application/x-www-form-urlencoded') => fetch(`${s2.base}${p}`, { method: 'POST', headers: { 'Content-Type': type, Origin: 'https://evil.example' }, body });
console.log('--- with API_TOKEN set ---');
for (const [p, b] of [['/api/patients', 'name=Evil'], ['/api/reset', ''], ['/api/patients/p1/simulate', 'text=chest+pain']]) console.log('form POST', p, '->', (await noTok(p, b)).status);
await s2.stop();
