// Safety check for core/smalltalk.js against the independent set: does an EMERGENCY message ever get
// a chatty, model-written line? (It must not: when the rules miss an emergency, the patient has to
// keep getting "I didn't catch that, tap the closest answer".) Also counts how much calm chat gets one.
//
//   node docs/independent-eval/smalltalk-check.mjs evals/independent-2026-10-11.jsonl [--model] [--quiet] [--backend=<path>]
//
// Without --model: rules only (which rows would be shown to a model at all: smalltalk.eligible).
// With --model: asks the model on LM Studio (LLM_PROVIDER=lmstudio) for the eligible rows, exactly
// as the backend would, and reports which got a line past the output check.
// --quiet prints numbers only (the held-out batch must stay unread).
// Only English and Spanish rows are used: in other languages the model never writes a line.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadRows, isEmergency } from './score.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const backend = path.resolve(opt('backend') ?? path.join(HERE, '..', '..', 'backend'));
const quiet = flag('quiet');
const useModel = flag('model');

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-smalltalk-check-${process.pid}.json`);
process.env.LLM_PROVIDER = useModel ? 'lmstudio' : 'none';
for (const k of ['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'NURSE_CHAT_ID']) delete process.env[k];
process.env.LLM_BREAKER_THRESHOLD = '99'; // measure every row instead of letting the breaker skip some

const from = (rel) => import(pathToFileURL(path.join(backend, rel)).href);
const parser = await from('src/core/parser.js');
const smalltalk = await from('src/core/smalltalk.js');
const store = await from('src/store.js');
const llm = await from('src/core/llm/index.js');
if (useModel) {
  await llm.detect({ force: true });
  console.log('model:', JSON.stringify(llm.status()));
  if (llm.status().provider === 'none') {
    console.log('No model answered on LM Studio; start it or drop --model.');
    process.exit(1);
  }
}

const rows = loadRows(file).filter((r) => r.label !== 'exclude' && (r.lang === 'en' || r.lang === 'es'));
const patient = store.getPatient('p2');
const out = [];
for (const r of rows) {
  const caught = isEmergency(parser.parseFreeText(r.text));
  const fixed = smalltalk.cannedKey(r.text);
  const eligible = !caught && !fixed && smalltalk.eligible(r.text, r.lang);
  let line = null;
  if (eligible && useModel) line = await smalltalk.fromModel(patient, r.text, { lang: r.lang });
  out.push({ ...r, caught, fixed, eligible, line: line?.text ?? null });
}

const show = (label) => {
  const list = out.filter((r) => r.label === label);
  const missed = list.filter((r) => !r.caught);
  const fixed = list.filter((r) => r.fixed);
  const eligible = list.filter((r) => r.eligible);
  const sent = list.filter((r) => r.line);
  console.log(`\n${label}: ${list.length} rows (en + es)${label === 'emergency' ? `, ${missed.length} missed by the red-flag rules` : ''}`);
  console.log(`  answered by a fixed line (rules):        ${fixed.length}`);
  console.log(`  shown to the model at all (eligible):    ${eligible.length}`);
  if (useModel) console.log(`  got a model-written line:                ${sent.length}`);
  if (!quiet) {
    for (const r of fixed) console.log(`    fixed    [${r.id} ${r.category}] ${r.text}`);
    for (const r of eligible) console.log(`    ${r.line ? 'LINE    ' : 'eligible'} [${r.id} ${r.category}] ${r.text}${r.line ? `\n             -> ${r.line}` : ''}`);
  }
};
console.log(`${path.basename(file)}${quiet ? ' (numbers only)' : ''}`);
show('emergency');
show('calm');
for (const f of [process.env.HEARTBRIDGE_DB, `${process.env.HEARTBRIDGE_DB}.bak`]) fs.rmSync(f, { force: true });
process.exit(0);
