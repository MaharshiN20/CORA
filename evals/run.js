// Language-layer eval (M4): how reliably do the rules parser and each LLM provider read
// patient messages? Writes evals/RESULTS.md.
//
//   cd backend && npm run eval                      # rules + every provider that's available
//   npm run eval -- --providers=rules,ollama        # pick providers
//   npm run eval -- --no-llm                        # rules only (no network, a few ms)
//   npm run eval -- --limit=20 --out=/tmp/r.md      # quick look
//
// Providers are pinned one at a time with LLM_PROVIDER, so each column is one model.
// Works with no LLM at all (rules only). Exit code 1 if the red-flag gate fails.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import * as parser from '../backend/src/core/parser.js';
import * as llm from '../backend/src/core/llm/index.js';
import { parseJsonl, validateRows, rulesPredict, hybridPredict, normalize, scoreRun, renderMarkdown, gate } from './score.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHAIN = ['claude', 'ollama', 'lmstudio'];

function args(argv) {
  const out = {};
  for (const a of argv) {
    const [k, v] = a.replace(/^--/, '').split('=');
    out[k] = v ?? true;
  }
  return out;
}

async function pin(provider) {
  process.env.LLM_PROVIDER = provider;
  llm._reset();
  await llm.detect({ force: true });
  const s = llm.status();
  return s.provider === provider ? s.model : null;
}

async function runLlm(rows, provider) {
  const preds = {};
  for (const [i, r] of rows.entries()) {
    const t0 = performance.now();
    try {
      preds[r.id] = { fields: normalize(await parser.parseWithLLM(r.text)), ms: performance.now() - t0 };
    } catch (err) {
      preds[r.id] = { fields: {}, ms: performance.now() - t0, error: err.message };
    }
    if ((i + 1) % 25 === 0) console.error(`  ${provider}: ${i + 1}/${rows.length}`);
  }
  return preds;
}

async function main() {
  const opts = args(process.argv.slice(2));
  const rows = parseJsonl(fs.readFileSync(path.join(here, 'messages.jsonl'), 'utf8')).slice(0, opts.limit ? Number(opts.limit) : undefined);
  const problems = validateRows(rows);
  if (problems.length) {
    console.error('messages.jsonl is invalid:\n' + problems.join('\n'));
    process.exit(2);
  }

  const results = {};
  const models = {};
  const skipped = [];

  // Rules: offline, instant.
  const rulesPreds = {};
  for (const r of rows) {
    const t0 = performance.now();
    rulesPreds[r.id] = { fields: rulesPredict(parser, r.text, r.step), ms: performance.now() - t0 };
  }
  results.rules = scoreRun(rows, rulesPreds);
  console.error(`rules: done (${rows.length} messages)`);

  const wanted = opts['no-llm'] ? [] : opts.providers ? String(opts.providers).split(',').filter((p) => CHAIN.includes(p)) : CHAIN;
  for (const provider of wanted) {
    const model = await pin(provider);
    if (!model) {
      skipped.push(provider);
      console.error(`${provider}: not available, skipped`);
      continue;
    }
    console.error(`${provider} (${model}): running ${rows.length} messages...`);
    const preds = await runLlm(rows, provider);
    results[provider] = scoreRun(rows, preds);
    models[provider] = model;
    // Hybrid reuses the same LLM answers: no extra calls.
    const hybrid = {};
    for (const r of rows) {
      const usedLlm = r.step !== 'free' && !Object.keys(rulesPreds[r.id].fields).length;
      hybrid[r.id] = {
        fields: hybridPredict(rulesPreds[r.id].fields, preds[r.id].fields, r.step),
        ms: rulesPreds[r.id].ms + (usedLlm ? preds[r.id].ms : 0),
        error: usedLlm ? preds[r.id].error : undefined,
      };
    }
    results[`hybrid:${provider}`] = scoreRun(rows, hybrid);
    models[`hybrid:${provider}`] = model;
  }

  const md = renderMarkdown({ rows, results, meta: { date: new Date().toISOString().slice(0, 10), models, skipped } });
  const out = opts.out ? path.resolve(String(opts.out)) : path.join(here, 'RESULTS.md');
  fs.writeFileSync(out, md + '\n');

  for (const [name, s] of Object.entries(results)) {
    console.log(`${name.padEnd(16)} P ${s.micro.precision}  R ${s.micro.recall}  red-flag ${s.redFlag.caught}/${s.redFlag.expected}  false alarms ${s.falseAlarm.alarms}/${s.falseAlarm.calm}`);
  }
  const g = gate(results.rules);
  console.log(`gate (rules red-flag recall en/es = 100%): ${g.pass ? 'PASS' : `FAIL, ${g.misses.length} missed: ${g.misses.map((m) => m.id).join(', ')}`}`);
  console.log(`wrote ${path.relative(process.cwd(), out)}`);
  if (!g.pass) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
