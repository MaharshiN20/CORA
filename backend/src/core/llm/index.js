// LLM provider chain: Claude -> Gemini -> Ollama -> LM Studio -> none.
//
// Everything that calls this MUST have a non-LLM fallback: when no provider is
// available (or every provider fails), complete()/completeJSON() return null and
// callers carry on with rules. Clinical decisions never go through here.
//
// LLM_PROVIDER=auto (default) picks the first available in chain order.
// LLM_PROVIDER=claude|gemini|ollama|lmstudio pins one; LLM_PROVIDER=none disables.
import * as anthropic from './anthropic.js';
import * as gemini from './gemini.js';
import { detectOllama, detectLmStudio } from './openaiCompat.js';

const DETECTORS = {
  claude: async () => anthropic.detect(),
  gemini: async () => gemini.detect(),
  ollama: detectOllama,
  lmstudio: detectLmStudio,
};
const CHAIN = ['claude', 'gemini', 'ollama', 'lmstudio'];
const REPROBE_MS = 60_000;

let providers = []; // available providers, in priority order
// Probe timing uses real time on purpose (infrastructure, not patient logic),
// so it is not affected by the demo clock.
let probedAt = 0;
let probing = null;

function wanted() {
  const pin = (process.env.LLM_PROVIDER || 'auto').toLowerCase();
  if (pin === 'none') return [];
  return CHAIN.includes(pin) ? [pin] : CHAIN;
}

// Probe every provider in the chain. Cached; re-probes every minute so starting
// Ollama/LM Studio (or adding a key) mid-session gets picked up.
export async function detect({ force = false } = {}) {
  if (!force && probedAt && Date.now() - probedAt < REPROBE_MS) return providers;
  probing ??= (async () => {
    const found = await Promise.all(wanted().map((n) => DETECTORS[n]().catch(() => null)));
    const before = providers.map((p) => p.name).join(',');
    providers = found.filter(Boolean);
    probedAt = Date.now();
    const after = providers.map((p) => p.name).join(',');
    if (before !== after) console.log(`[llm] providers: ${after || 'none (rule fallbacks)'}`);
    return providers;
  })().finally(() => (probing = null));
  return probing;
}

// Synchronous view for callers that just want to know whether to try.
// Kicks off a background re-probe when the cache is stale.
export function enabled() {
  if (Date.now() - probedAt >= REPROBE_MS) detect().catch(() => {});
  return providers.length > 0;
}

// The provider that will actually answer next (skips ones cooling down after a quota/key error).
export function status() {
  const now = Date.now();
  const cooling = providers.filter((x) => (coolingUntil.get(x.name) ?? 0) > now).map((x) => x.name);
  const p = providers.find((x) => !cooling.includes(x.name));
  return { provider: p?.name ?? 'none', model: p?.model ?? null, available: providers.map((x) => x.name), ...(cooling.length && { cooling }) };
}

// Try each available provider in order; fall through on errors.
// Providers that can't serve for a while are skipped instead of costing a failed call (plus a
// retry) on every patient message: an exhausted quota (429 "quota") or a rejected key (401/403).
// Brief 503/429 spikes are retried inside the provider and don't trigger this.
const COOLDOWN_MS = { quota: 10 * 60_000, auth: 30 * 60_000 };
const coolingUntil = new Map(); // provider name -> ms (real time: infrastructure, not the demo clock)

function coolDownIfNeeded(p, err) {
  const msg = String(err?.message ?? '');
  const reason = err?.status === 401 || err?.status === 403 ? 'auth' : err?.status === 429 && /quota|billing|exceeded/i.test(msg) ? 'quota' : null;
  if (!reason) return;
  coolingUntil.set(p.name, Date.now() + COOLDOWN_MS[reason]);
  console.error(`[llm] ${p.name} ${reason === 'quota' ? 'quota exhausted' : 'key rejected'}: skipping it for ${COOLDOWN_MS[reason] / 60000} min`);
}

// deadlineMs caps the WHOLE chain (every provider + retries), for calls a patient is
// waiting on: past it we return null and the caller falls back to rules. The slow provider
// call is left to finish in the background; its answer is ignored.
async function run(opts) {
  if (!opts.deadlineMs) return runChain(opts);
  let timer;
  const expired = new Promise((resolve) => (timer = setTimeout(() => resolve(null), opts.deadlineMs)));
  try {
    return await Promise.race([runChain(opts).catch(() => null), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function runChain(opts) {
  for (const p of await detect()) {
    if ((coolingUntil.get(p.name) ?? 0) > Date.now()) continue;
    try {
      const text = (await p.chat(opts))?.trim();
      if (text) return text;
    } catch (err) {
      coolDownIfNeeded(p, err);
      console.error(`[llm] ${p.name} failed, trying next:`, err.message);
    }
  }
  return null;
}

// opts (all optional, per call): { json, schema, model, timeoutMs, deadlineMs }
//   deadlineMs -> hard cap on the whole provider chain (null when it expires)
//   schema    -> enforced as JSON schema where the provider supports it (Gemini, LM Studio, Ollama)
//   model     -> preferred model, used only by a provider that has it (else its default)
//   timeoutMs -> per-call timeout (default 60s; CPU-only local reviews can need more)
export function complete(system, user, maxTokens = 400, opts = {}) {
  return run({ system, user, maxTokens, ...opts });
}

// Returns parsed JSON or null. opts: { maxTokens = 400, schema, model, timeoutMs }
export async function completeJSON(system, user, { maxTokens = 400, ...opts } = {}) {
  const text = await run({ system: `${system}\nRespond with ONLY a JSON object, no prose.`, user, maxTokens, json: true, ...opts });
  if (!text) return null;
  try {
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
}

// Test hook
export function _reset() {
  coolingUntil.clear();
  providers = [];
  probedAt = 0;
  probing = null;
}
