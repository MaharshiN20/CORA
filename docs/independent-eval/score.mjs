// Scores a batch of the independent set against the real rules (no model, no server).
//   node docs/independent-eval/score.mjs evals/independent-2026-10-10.jsonl [--quiet] [--json=out.json] [--backend=<path to a backend/ checkout>]
// --quiet prints numbers only (used on the held-out batch so nobody tunes against its wording).
// --backend scores another checkout of the code (e.g. a git worktree of the commit before the fixes).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function loadRows(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// "Call 911 now", the same rule as isEmergency in core/checkin.js (COPD patients aside).
export const isEmergency = (a = {}) => !!(a.chestPain || a.breath === 'rest' || a.confusion || a.fainting || a.otherEmergency || (a.spo2 != null && a.spo2 < 90));

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');

// rows: the batch; fired: Map(id -> boolean) = did the system say 911. Rows labelled 'exclude' are skipped.
export function summarise(rows, fired) {
  const used = rows.filter((r) => r.label !== 'exclude' && fired.has(r.id));
  const tally = (list) => {
    const em = list.filter((r) => r.label === 'emergency');
    const calm = list.filter((r) => r.label === 'calm');
    return { emergencies: em.length, caught: em.filter((r) => fired.get(r.id)).length, calm: calm.length, alarms: calm.filter((r) => fired.get(r.id)).length };
  };
  const group = (key) => {
    const out = {};
    for (const k of [...new Set(used.map(key))].sort()) out[k] = tally(used.filter((r) => key(r) === k));
    return out;
  };
  return {
    rows: used.length,
    overall: tally(used),
    byLang: group((r) => r.lang),
    byCategory: group((r) => r.category),
    byLangCategory: group((r) => `${r.lang} ${r.category}`),
    bySource: group((r) => r.source),
    byStyle: group((r) => r.style),
    misses: used.filter((r) => r.label === 'emergency' && !fired.get(r.id)),
    falseAlarms: used.filter((r) => r.label === 'calm' && fired.get(r.id)),
  };
}

export function render(title, s, { quiet = false, detail = () => '' } = {}) {
  const L = [`## ${title}`, ''];
  const line = (name, t) => `| ${name} | ${t.emergencies ? `${t.caught}/${t.emergencies} (${pct(t.caught, t.emergencies)})` : 'n/a'} | ${t.calm ? `${t.alarms}/${t.calm} (${pct(t.alarms, t.calm)})` : 'n/a'} |`;
  const table = (head, obj) => {
    L.push(`| ${head} | Emergencies caught (recall) | False alarms on calm messages |`, '|---|---|---|');
    for (const [k, t] of Object.entries(obj)) L.push(line(k, t));
    L.push('');
  };
  table('All', { [`${s.rows} messages`]: s.overall });
  table('Language', s.byLang);
  table('Category', s.byCategory);
  table('Written by', s.bySource);
  table('Style', s.byStyle);
  if (!quiet) {
    L.push(`### Missed emergencies (${s.misses.length})`, '');
    for (const r of s.misses) L.push(`- \`${r.id}\` ${r.category} / ${r.style}: ${r.text}${detail(r)}`);
    L.push('', `### False alarms (${s.falseAlarms.length})`, '');
    for (const r of s.falseAlarms) L.push(`- \`${r.id}\` ${r.category} / ${r.style}: ${r.text}${detail(r)}`);
    L.push('');
  }
  return L.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const quiet = args.includes('--quiet');
  const backend = path.resolve(opt('backend') ?? path.join(HERE, '../../backend'));

  // Rules only, and nothing may touch the real database or a model.
  process.env.LLM_PROVIDER = 'none';
  process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-indep-score-${process.pid}.json`);
  const parser = await import(pathToFileURL(path.join(backend, 'src/core/parser.js')).href);

  const rows = loadRows(file);
  const fired = new Map();
  const flags = new Map();
  for (const r of rows) {
    const a = parser.parseFreeText(r.text);
    fired.set(r.id, isEmergency(a));
    flags.set(r.id, a);
  }
  const s = summarise(rows, fired);
  console.log(render(`Rules only (parseFreeText): ${path.basename(file)}`, s, { quiet, detail: (r) => (Object.keys(flags.get(r.id)).length ? `  \`${JSON.stringify(flags.get(r.id))}\`` : '') }));
  const json = opt('json');
  if (json) fs.writeFileSync(json, JSON.stringify({ file, backend, summary: { ...s, misses: s.misses.map((r) => r.id), falseAlarms: s.falseAlarms.map((r) => r.id) }, fired: Object.fromEntries(fired) }, null, 1));
  for (const f of [process.env.HEARTBRIDGE_DB, `${process.env.HEARTBRIDGE_DB}.bak`]) try { fs.rmSync(f, { force: true }); } catch {}
}
