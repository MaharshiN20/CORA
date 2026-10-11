import { startServer, stats } from './lab.mjs';

const srv = await startServer({ port: 3072, env: { LLM_PROVIDER: 'none' }, label: 'fuzz' });
const results = [];
const bad = [];
const record = (name, r, note = '') => {
  results.push(r.ms);
  const leak = /\bat .*\.(js|mjs):\d+|node_modules|C:\\|D:\\|\/Users\/|ECONN|SyntaxError at|TypeError:|ReferenceError/.test(r.text);
  if (r.status >= 500 || leak || r.ms > 3000) bad.push({ name, status: r.status, ms: r.ms, leak, snippet: r.text.slice(0, 160), note });
};

const WEIRD = [null, true, false, 0, -1, 1e308, NaN, '', ' ', 'x'.repeat(5000), [], {}, [[]], { a: { b: { c: {} } } }, '<script>alert(1)</script>', "'; DROP TABLE patients;--", '../../etc/passwd', '%00', '\u0000', '__proto__', { __proto__: { admin: true } }, '😀'.repeat(200), 'ñ'.repeat(3000), ['a', 'b'], 12345678901234567890n.toString()];
const IDS = ['p1', 'nope', '', '__proto__', 'constructor', '../p1', 'p1%00', 'P1', ' p1', 'p1 ', 'p1;', '%2e%2e%2f', 'toString', 'hasOwnProperty'];

async function sendRaw(method, path, body, headers = {}) {
  return srv.call(method, path, body, headers);
}

// 1. every JSON-body POST/PATCH with every weird value in every plausible field
const bodyRoutes = [
  ['POST', '/api/patients', ['name', 'age', 'language', 'profile', 'meds', 'weights', 'caregiver', 'prescriptions', 'id', 'linkCode', 'dischargedAt', 'dryWeightLb']],
  ['POST', '/api/patients/p1/simulate', ['text', 'buttonData', 'role', 'photo']],
  ['POST', '/api/patients/p1/message', ['text', 'template', 'time', 'from']],
  ['POST', '/api/devices/readings', ['patientId', 'type', 'value', 'device', 'ts', 'readingId']],
  ['PATCH', '/api/alerts', ['ids', 'status', 'assignee', 'by', 'outcome', 'note']],
  ['POST', '/api/patients/p1/unlink', ['role']],
  ['POST', '/api/demo/advance', ['hours']],
  ['POST', '/api/fhir/import', ['fhirPatientId', 'override']],
  ['POST', '/api/insights/cohort/regenerate', ['seed', 'size']],
  ['POST', '/api/patients/p1/prescriptions/furosemide/picked-up', ['by']],
  ['POST', '/api/patients/p1/digest', []],
];
let n = 0;
for (const [method, path, fields] of bodyRoutes) {
  for (const f of fields) {
    for (const w of WEIRD) {
      const body = typeof w === 'bigint' ? { [f]: String(w) } : { [f]: w };
      let r;
      try { r = await sendRaw(method, path, body); } catch (e) { bad.push({ name: `${method} ${path}`, status: 'EXC', snippet: String(e).slice(0, 120) }); continue; }
      n++;
      record(`${method} ${path} {${f}: ${JSON.stringify(w)?.slice(0, 30)}}`, r);
    }
  }
}
// 2. malformed bodies
for (const raw of ['{', '[', 'null', '"str"', '123', '{"a":', '\u0000', '{"a":1}}', '[1,2,3]', 'true']) {
  for (const [method, path] of [['POST', '/api/patients'], ['POST', '/api/patients/p1/simulate'], ['PATCH', '/api/alerts'], ['POST', '/api/devices/readings']]) {
    const r = await sendRaw(method, path, raw);
    n++;
    record(`${method} ${path} raw=${JSON.stringify(raw)}`, r);
  }
}
// 3. path params
for (const id of IDS) {
  for (const [method, tmpl] of [['GET', '/api/patients/ID'], ['GET', '/api/patients/ID/timeline'], ['GET', '/api/patients/ID/risk-history'], ['GET', '/api/patients/ID/digest'], ['POST', '/api/patients/ID/checkin'], ['POST', '/api/patients/ID/unlink'], ['POST', '/api/patients/ID/sdoh/start'], ['GET', '/api/fhir/export/ID'], ['GET', '/api/fhir/preview/ID'], ['PATCH', '/api/alerts/ID'], ['POST', '/api/alerts/ID/protocol']]) {
    const r = await sendRaw(method, tmpl.replace('ID', encodeURIComponent(id)), method === 'GET' ? undefined : {});
    n++;
    record(`${method} ${tmpl.replace('ID', JSON.stringify(id))}`, r);
  }
}
// 4. query strings
for (const q of ['limit=-5', 'limit=abc', 'limit=1e9', 'kinds=__proto__', 'kinds=', 'from=garbage', 'to=%00', 'patientId[]=p1', 'patientId[a]=1', 'type=%27', 'source=%00', 'nurses=-1', 'nurses=abc', 'discharges[]=1', 'reduction=NaN', 'seed=abc&size=999999999', 'name=a', 'name=' + 'a'.repeat(5000), 'lang=zz', 'status=open&status=open']) {
  for (const p of ['/api/audit.csv', '/api/patients/p1/timeline', '/api/insights/impact', '/api/insights/roi', '/api/fhir/search', '/api/demo/jobs', '/api/patients/p1/digest']) {
    const r = await sendRaw('GET', `${p}?${q}`);
    n++;
    record(`GET ${p}?${q.slice(0, 40)}`, r);
  }
}
// 5. oversized + wrong content types
{
  const big = JSON.stringify({ text: 'x'.repeat(2_000_000) });
  const r = await sendRaw('POST', '/api/patients/p1/simulate', big);
  record('2MB simulate body', r, 'expect 413');
  console.log('2MB simulate ->', r.status);
  const r2 = await srv.call('POST', '/api/patients', 'name=Bob', { 'Content-Type': 'application/x-www-form-urlencoded' });
  console.log('form-encoded POST /api/patients ->', r2.status, r2.text.slice(0, 80));
  const r3 = await srv.call('POST', '/api/patients/p1/simulate', '{"text":"hi"}', { 'Content-Type': 'text/plain' });
  console.log('text/plain JSON body ->', r3.status, r3.text.slice(0, 80));
}
// 6. prototype pollution probe
await sendRaw('POST', '/api/patients', '{"name":"Poll","__proto__":{"polluted":"yes"},"profile":{"__proto__":{"polluted2":"yes"}}}');
const check = await sendRaw('GET', '/api/health');
console.log('pollution check (Object.prototype.polluted on server) — probe via health shape:', check.status);
const probe = await sendRaw('POST', '/api/patients', { name: 'Probe Person' });
console.log('probe patient has inherited `polluted`:', probe.json && ('polluted' in probe.json || 'polluted2' in probe.json));

console.log(`requests sent: ${n}; latency`, JSON.stringify(stats(results)));
console.log(`PROBLEMS (5xx / stack-or-path leak / >3s): ${bad.length}`);
const grouped = {};
for (const b of bad) (grouped[`${b.status} ${b.name.split(' {')[0].split(' raw=')[0].split('?')[0]}`] ??= []).push(b);
for (const [k, v] of Object.entries(grouped)) console.log(`  ${v.length}x ${k} e.g. ${v[0].name} -> ${v[0].snippet.replace(/\s+/g, ' ')}`);
await srv.stop();
