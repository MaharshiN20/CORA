// Generates the raw pool for the independent red-flag set from a model that never saw the rules.
//   node docs/independent-eval/generate.mjs --provider=lmstudio --out=<file.jsonl>
//   node --env-file=backend/.env docs/independent-eval/generate.mjs --provider=gemini --out=<file.jsonl>
// Resumable: a request whose key is already in the output file is skipped. One JSON row per message:
//   { key, provider, model, lang, category, label, style, variant, text }
import fs from 'node:fs';
import { CATEGORIES, LANGS, STYLES, SYSTEM, buildPrompt } from './spec.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const provider = args.provider ?? 'lmstudio';
const out = args.out;
if (!out) throw new Error('--out=<file.jsonl> is required');
const langs = (args.langs ?? Object.keys(LANGS).join(',')).split(',');
const limit = Number(args.limit ?? Infinity);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROVIDERS = {
  lmstudio: {
    url: (process.env.LMSTUDIO_URL ?? 'http://127.0.0.1:1234/v1') + '/chat/completions',
    headers: {},
    models: [process.env.LMSTUDIO_MODEL ?? 'qwen2.5-7b-instruct'],
    pauseMs: 0,
    maxTokens: 1400,
    format: (n) => ({
      type: 'json_schema',
      json_schema: { name: 'response', schema: { type: 'object', properties: { messages: { type: 'array', items: { type: 'string' }, minItems: n, maxItems: n } }, required: ['messages'] } },
    }),
  },
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    headers: { Authorization: `Bearer ${process.env.GEMINI_API_KEY}` },
    // First that answers wins; a 429 / 503 moves on to the next one.
    models: (process.env.GEMINI_MODELS ?? 'gemini-3.5-flash,gemini-flash-lite-latest').split(','),
    pauseMs: 4500, // stay under a free-tier requests-per-minute cap
    maxTokens: 12000,
    format: () => ({ type: 'json_object' }),
  },
};
const P = PROVIDERS[provider];
if (!P) throw new Error(`unknown provider ${provider}`);
if (provider === 'gemini' && !process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');

// The request plan. English: 3 circumstances per (category, style) from each generator. Other
// languages: 1 per (category, style) from each generator. The local model gets one small request
// per style; Gemini gets one request per category (fewer calls against its daily quota).
const styleIds = Object.keys(STYLES);
const catIds = Object.keys(CATEGORIES);
const shift = provider === 'gemini' ? 2 : 0; // the two generators start on different circumstances
function plan() {
  const requests = [];
  for (const lang of langs) {
    const per = lang === 'en' ? 3 : 1;
    catIds.forEach((category, c) => {
      const items = styleIds.flatMap((style, s) => Array.from({ length: per }, (_, k) => ({ style, variant: (s + c + k + shift) % 4 })));
      if (provider === 'gemini') requests.push({ key: `${provider}|${lang}|${category}|all`, lang, category, items });
      else for (const style of styleIds) requests.push({ key: `${provider}|${lang}|${category}|${style}`, lang, category, items: items.filter((it) => it.style === style) });
    });
  }
  return requests;
}

async function ask(model, req) {
  const res = await fetch(P.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...P.headers },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model,
      temperature: 0.95,
      max_tokens: P.maxTokens,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: buildPrompt(req.lang, req.category, req.items) }],
      response_format: P.format(req.items.length),
    }),
  });
  if (!res.ok) throw Object.assign(new Error(`${model} ${res.status}: ${(await res.text()).slice(0, 160)}`), { status: res.status });
  const body = await res.json();
  const content = (Array.isArray(body) ? body[0] : body).choices?.[0]?.message?.content ?? '';
  const json = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  const messages = (Array.isArray(json) ? json : json.messages)?.map((m) => (typeof m === 'string' ? m : (m?.text ?? m?.message ?? ''))).map((m) => String(m).trim());
  if (!Array.isArray(messages) || messages.length !== req.items.length || messages.some((m) => !m)) throw new Error(`wrong shape: wanted ${req.items.length}, got ${messages?.length}`);
  return messages;
}

const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).key) : []);
const todo = plan().filter((r) => !done.has(r.key)).slice(0, limit);
console.log(`${provider}: ${todo.length} requests to make (${done.size} already done)`);
let made = 0, failed = 0;
let models = [...P.models];
for (const req of todo) {
  let messages = null, used = null;
  for (let attempt = 0; attempt < 4 && !messages && models.length; attempt++) {
    used = models[0];
    try {
      messages = await ask(used, req);
    } catch (err) {
      console.log(`  ${req.key} attempt ${attempt + 1} on ${used}: ${String(err.message).slice(0, 120)}`);
      // Out of quota or overloaded: wait once, then drop to the next model for the rest of the run.
      if (err.status === 429 || err.status === 503) {
        if (attempt === 0) await sleep(20_000);
        else if (models.length > 1) { console.log(`  ${used} -> ${err.status}, switching to ${models[1]}`); models = models.slice(1); }
        else await sleep(60_000);
      }
      if (attempt === 3) console.log(`  FAILED ${req.key}: ${err.message}`);
    }
  }
  if (!messages) { failed++; continue; }
  const rows = messages.map((text, i) => ({ key: req.key, provider, model: used, lang: req.lang, category: req.category, label: CATEGORIES[req.category].label, style: req.items[i].style, variant: req.items[i].variant, text }));
  fs.appendFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  made += rows.length;
  done.add(req.key);
  if (done.size % 20 === 0) console.log(`  ${done.size} requests done, ${made} messages this run`);
  if (P.pauseMs) await sleep(P.pauseMs);
}
console.log(`${provider}: wrote ${made} messages, ${failed} requests failed -> ${out}`);
