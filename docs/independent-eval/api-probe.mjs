// Nurse-side API probe on the REAL server (throwaway database, no model): every route gets a
// matrix of wrong-typed and hostile bodies, then the security switches are checked.
//   node docs/independent-eval/api-probe.mjs [--port=3096]
// Passes when nothing answers 5xx, nothing hangs, and the guards answer what CONTRACTS.md says.
import { boot } from '../uat-2026-10-11/lab.mjs';

const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 3096);
const findings = [];
const note = (what, detail) => findings.push(`${what}: ${detail}`);

const BAD = [null, true, 0, -1, 1e308, '', ' ', 'x'.repeat(5000), [], [1, 2], {}, { a: 1 }, { length: 3 }, '__proto__', ['__proto__'], { __proto__: { x: 1 } }, '<img src=x onerror=alert(1)>', '=cmd|calc', '\u0000', '2026-13-45', 'NaN'];

async function run(env, fn) {
  const srv = await boot({ port: PORT, env });
  const raw = async (method, path, body, headers = {}) => {
    const init = { method, headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(20_000) };
    try {
      const r = await fetch(srv.base + path, init);
      return { status: r.status, text: await r.text() };
    } catch (err) {
      return { status: 0, text: String(err.message) };
    }
  };
  try {
    await fn({ srv, raw });
    const crashed = srv.log.join('').split('\n').filter((l) => /TypeError|ReferenceError|RangeError|Unhandled|handler failed/.test(l));
    for (const l of [...new Set(crashed)].slice(0, 12)) note('server log', l.slice(0, 220));
  } finally {
    await srv.stop();
  }
}

// ---------- 1. wrong types everywhere ----------
await run({}, async ({ srv, raw }) => {
  const made = await srv.post('/api/patients', { name: 'Probe One', language: 'en', dryWeightLb: 170, weights: [{ ts: new Date(Date.now() - 86_400_000).toISOString(), lb: 170 }], caregiver: { name: 'Cee Gee', language: 'en' }, prescriptions: [{ med: 'Furosemide', expectedPickup: new Date(Date.now() - 86_400_000).toISOString() }] });
  const id = made.json.id;
  await srv.post(`/api/patients/${id}/simulate`, { text: 'my ankles are more swollen and I gained weight' });
  await srv.post(`/api/patients/${id}/simulate`, { buttonData: 'ci:rf:none' });
  await srv.post(`/api/patients/${id}/simulate`, { text: '176' });
  for (const d of ['ci:breath:exertion', 'ci:orth:pillows', 'ci:swell:worse', 'ci:diu:no', 'ci:spo2:none']) await srv.post(`/api/patients/${id}/simulate`, { buttonData: d });
  const alert = (await srv.get('/api/alerts')).json.find((a) => a.patientId === id) ?? { id: 'none' };

  const check = async (method, path, body) => {
    const r = await raw(method, path, body);
    if (r.status >= 500 || r.status === 0) note(`${r.status || 'HANG'} ${method} ${path}`, `${JSON.stringify(body)?.slice(0, 120)} -> ${r.text.slice(0, 160)}`);
    return r;
  };
  const fields = {
    [`POST /api/patients`]: ['name', 'age', 'language', 'profile', 'meds', 'prescriptions', 'weights', 'caregiver', 'source', 'dryWeightLb', 'timezone', 'dischargedAt', 'followUp', 'carePlan'],
    [`POST /api/patients/${id}/simulate`]: ['text', 'buttonData', 'role', 'photo'],
    [`POST /api/patients/${id}/message`]: ['text', 'template', 'time', 'from'],
    [`PATCH /api/alerts/${alert.id}`]: ['status', 'outcome', 'assignee', 'note', 'by'],
    [`PATCH /api/alerts`]: ['ids', 'status', 'assignee', 'by'],
    [`POST /api/alerts/${alert.id}/protocol`]: ['by', 'protocolId'],
    [`POST /api/devices/readings`]: ['patientId', 'type', 'value', 'device', 'ts', 'readingId'],
    [`POST /api/demo/advance`]: ['hours'],
    [`POST /api/patients/${id}/unlink`]: ['role'],
    [`POST /api/patients/${id}/prescriptions/Furosemide/picked-up`]: ['by'],
    [`POST /api/insights/cohort/regenerate`]: ['seed', 'size'],
    [`POST /api/fhir/import`]: ['fhirPatientId', 'override'],
  };
  const baseBody = { [`POST /api/patients`]: { name: 'Probe Two' }, [`POST /api/devices/readings`]: { patientId: id, type: 'weight', value: 171 }, [`PATCH /api/alerts`]: { ids: [alert.id], assignee: 'Kim' }, [`POST /api/patients/${id}/simulate`]: { text: 'hello' }, [`POST /api/patients/${id}/message`]: { text: 'hello' } };
  for (const [route, names] of Object.entries(fields)) {
    const [method, path] = route.split(' ');
    for (const name of names) for (const bad of BAD) await check(method, path, { ...(baseBody[route] ?? {}), [name]: bad });
    for (const whole of [null, [], 'text', 42, '{"a":']) await check(method, path, whole);
  }
  // Unknown ids and odd paths on every route that takes one.
  for (const pid of ['nope', '__proto__', 'constructor', '..%2f..%2fetc', '%00', 'a'.repeat(2000)]) {
    for (const [method, tail] of [['GET', ''], ['GET', '/risk-history'], ['GET', '/timeline?limit=-5&kinds=x'], ['GET', '/digest?lang=zz'], ['POST', '/digest'], ['POST', '/checkin'], ['POST', '/simulate'], ['POST', '/message'], ['POST', '/sdoh/start'], ['POST', '/unlink'], ['POST', '/prescriptions/x/picked-up']]) {
      await check(method, `/api/patients/${pid}${tail}`, method === 'POST' ? { text: 'hi' } : undefined);
    }
    await check('PATCH', `/api/alerts/${pid}`, { status: 'acknowledged' });
    await check('POST', `/api/alerts/${pid}/protocol`, {});
    await check('POST', `/api/demo/scenario/${pid}`, {});
    await check('GET', `/api/fhir/export/${pid}`);
  }
  for (const q of ['?limit=abc', '?from=x', '?patientId[]=a&patientId[]=b', '?type[a]=b', '?limit=999999999']) await check('GET', `/api/audit.csv${q}`);
  for (const q of ['?source=x', '?source[]=a', '?discharges=-1&readmitRate=NaN&costPerReadmit=1e999']) for (const p of ['impact', 'engagement', 'equity', 'roi']) await check('GET', `/api/insights/${p}${q}`);
  for (const q of ['?patientId[]=a', '?status[x]=y', '?kind=%00']) await check('GET', `/api/demo/jobs${q}`);
  // Too-large bodies answer 413 as JSON, never a stack trace.
  const big = await raw('POST', `/api/patients/${id}/message`, { text: 'x'.repeat(200_000) });
  if (big.status !== 413) note('100 KB cap', `expected 413, got ${big.status} ${big.text.slice(0, 100)}`);
  const photo = await raw('POST', `/api/patients/${id}/simulate`, { photo: { base64: 'A'.repeat(11 * 1024 * 1024), mime: 'image/jpeg' } });
  if (photo.status !== 413) note('10 MB cap on simulate', `expected 413, got ${photo.status} ${photo.text.slice(0, 100)}`);
  // Webhooks with nonsense.
  for (const [path, body, headers] of [['/webhooks/twilio/sms', 'From=%2B1&Body=%00', { 'Content-Type': 'application/x-www-form-urlencoded' }], ['/webhooks/twilio/whatsapp', 'From[]=a&From[]=b&Body[x]=y', { 'Content-Type': 'application/x-www-form-urlencoded' }], ['/webhooks/withings', '{"userid":1,"measuregrps":"x"}', { 'Content-Type': 'application/json' }], ['/webhooks/telegram', '{"update_id":"x"}', { 'Content-Type': 'application/json' }], ['/webhooks/twilio/sms', '{"From":"+1"}', { 'Content-Type': 'application/json' }]]) {
    const r = await raw('POST', path, body, headers);
    if (r.status >= 500 || r.status === 0) note(`${r.status || 'HANG'} POST ${path}`, `${body.slice(0, 60)} -> ${r.text.slice(0, 160)}`);
  }
  // The server is still alive and the data still loads.
  const alive = await srv.get(`/api/patients/${id}`);
  if (alive.status !== 200) note('after the probe', `GET patient -> ${alive.status}`);
});

// ---------- 2. security switches ----------
await run({ API_TOKEN: 'probe-token' }, async ({ raw }) => {
  const expect = async (what, r, status) => { const got = (await r).status; if (got !== status) note('API_TOKEN', `${what}: expected ${status}, got ${got}`); };
  await expect('no token on /patients', raw('GET', '/api/patients'), 401);
  await expect('wrong token', raw('GET', '/api/patients', undefined, { Authorization: 'Bearer nope' }), 401);
  await expect('token as query string is not accepted', raw('GET', '/api/patients?token=probe-token'), 401);
  await expect('right token', raw('GET', '/api/patients', undefined, { Authorization: 'Bearer probe-token' }), 200);
  await expect('x-api-token header', raw('GET', '/api/alerts', undefined, { 'x-api-token': 'probe-token' }), 200);
  await expect('/health stays public', raw('GET', '/api/health'), 200);
  await expect('/ready stays public', raw('GET', '/api/ready'), 200);
  await expect('/join stays public', raw('GET', '/api/join'), 200);
  await expect('simulate needs the token', raw('POST', '/api/patients/p1/simulate', { text: 'hi' }), 401);
  await expect('demo reset needs the token', raw('POST', '/api/demo/reset', {}), 401);
  await expect('audit export needs the token', raw('GET', '/api/audit.csv'), 401);
  await expect('fhir export needs the token', raw('GET', '/api/fhir/export/p1'), 401);
  await expect('insights need the token', raw('GET', '/api/insights/impact'), 401);
  await expect('device readings need a key or the token', raw('POST', '/api/devices/readings', { patientId: 'p1', type: 'weight', value: 170 }), 401);
  const ready = await raw('GET', '/api/ready');
  if (/probe-token|TELEGRAM|chatId|\+1\d{6}/.test(ready.text)) note('/ready', 'leaks a secret-looking value');
});
await run({}, async ({ raw }) => {
  const expect = async (what, r, status) => { const got = (await r).status; if (got !== status) note('cross-site guard', `${what}: expected ${status}, got ${got}`); };
  await expect('POST from a foreign Origin', raw('POST', '/api/patients', { name: 'Evil' }, { Origin: 'https://evil.example' }), 403);
  await expect('POST with Origin: null', raw('POST', '/api/demo/reset', {}, { Origin: 'null' }), 403);
  await expect('PATCH from a foreign Origin', raw('PATCH', '/api/alerts', { ids: ['x'], assignee: 'E' }, { Origin: 'http://evil.example:5173' }), 403);
  await expect('cross-site fetch metadata without Origin', raw('POST', '/api/demo/reset', {}, { 'Sec-Fetch-Site': 'cross-site' }), 403);
  await expect('POST from the local dashboard origin', raw('POST', '/api/demo/tick', {}, { Origin: 'http://localhost:5173' }), 200);
  await expect('look-alike origin localhost.evil.example', raw('POST', '/api/demo/tick', {}, { Origin: 'http://localhost.evil.example' }), 403);
  await expect('look-alike origin 127.0.0.1.evil.example', raw('POST', '/api/demo/tick', {}, { Origin: 'http://127.0.0.1.evil.example' }), 403);
  await expect('a form post (urlencoded) to a JSON route does nothing', raw('POST', '/api/demo/advance', 'hours=48', { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' }), 403);
});
// Host header: fetch() will not let us set it, so use a raw socket.
await run({}, async ({ srv }) => {
  const net = await import('node:net');
  const ask = (host) => new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1', () => s.write(`GET /api/patients HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    let data = '';
    s.on('data', (d) => (data += d));
    s.on('end', () => resolve(Number(data.split(' ')[1])));
    s.on('error', () => resolve(0));
  });
  // ("evil.example:80@localhost" is read as host localhost and passes; no browser can send that Host, so it is not a hole.)
  for (const [host, want] of [['evil.example', 421], ['localhost:3096', 200], ['127.0.0.1', 200], ['localhost.evil.example', 421]]) {
    const got = await ask(host);
    if (got !== want && !(want === 421 && got === 400)) note('Host guard', `Host: ${host} expected ${want}, got ${got}`);
  }
  void srv;
});

console.log(findings.length ? `FINDINGS: ${findings.length}\n${findings.map((f) => `  - ${f}`).join('\n')}` : 'no findings');
process.exitCode = findings.length ? 1 : 0;
