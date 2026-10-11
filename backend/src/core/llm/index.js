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
  return providers.length > 0 && !breakerOpen();
}

// Circuit breaker. A model that is up but hung, slow or erroring is worse than none: every patient
// message pays the full timeout again (measured: 184 s for one Korean "chest pain"). After
// BREAKER_THRESHOLD consecutive failures (timeout, deadline overrun, 5xx, network) the chain is
// "unhealthy" for BREAKER_OPEN_MS: enabled() is false and complete() returns null at once, so every
// caller takes its no-model path (rules, English fallback, the "call 911 if..." safety-net line).
// After the window one call is let through; success closes the breaker, failure reopens it.
// Real time on purpose (infrastructure, not the demo clock).
const BREAKER_THRESHOLD = Number(process.env.LLM_BREAKER_THRESHOLD ?? 2);
const BREAKER_OPEN_MS = Number(process.env.LLM_BREAKER_OPEN_MS ?? 30_000);
let failures = 0;
let openUntil = 0;
const breakerOpen = () => Date.now() < openUntil;
function recordFailure(why) {
  failures++;
  if (failures >= BREAKER_THRESHOLD) {
    if (!breakerOpen()) console.error(`[llm] ${failures} failures in a row (${why}): treating the model as unavailable for ${BREAKER_OPEN_MS / 1000}s`);
    openUntil = Date.now() + BREAKER_OPEN_MS;
  }
}
function recordSuccess() {
  failures = 0;
  openUntil = 0;
}
// A 4xx other than 429 is our request being refused (bad schema, context too long), not the model being down.
const countsAsOutage = (err) => !err?.status || err.status >= 500 || err.status === 429;

// The provider that will actually answer next (skips ones cooling down after a quota/key error).
export function status() {
  const now = Date.now();
  const cooling = providers.filter((x) => (coolingUntil.get(x.name) ?? 0) > now).map((x) => x.name);
  const p = providers.find((x) => !cooling.includes(x.name));
  return { provider: p?.name ?? 'none', model: p?.model ?? null, available: providers.map((x) => x.name), ...(cooling.length && { cooling }), ...(breakerOpen() && { unhealthy: true }) };
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
  if (breakerOpen()) return null; // unhealthy: behave exactly like "no model"
  const state = { late: false };
  if (!opts.deadlineMs) return runChain(opts, state);
  let timer;
  const expired = new Promise((resolve) =>
    (timer = setTimeout(() => {
      state.late = true; // a straggler's success no longer counts as health
      if (!opts.signal?.aborted) recordFailure(`no answer within ${opts.deadlineMs} ms`);
      resolve(null);
    }, opts.deadlineMs)),
  );
  try {
    return await Promise.race([runChain(opts, state).catch(() => null), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function runChain(opts, state) {
  for (const p of await detect()) {
    // The caller gave up (opts.signal): don't start, or move on to, another provider.
    if (opts.signal?.aborted) return null;
    if ((coolingUntil.get(p.name) ?? 0) > Date.now()) continue;
    if (opts.image && !p.vision) continue; // a text-only model can't read the photo
    try {
      const text = (await p.chat(opts))?.trim();
      if (text) {
        if (!state.late) recordSuccess();
        return text;
      }
    } catch (err) {
      if (opts.signal?.aborted) return null; // cancelled by the caller, not a provider failure
      if (countsAsOutage(err) && !state.late) recordFailure(err.message.slice(0, 80));
      coolDownIfNeeded(p, err);
      console.error(`[llm] ${p.name} failed, trying next:`, err.message);
    }
  }
  return null;
}

// opts (all optional, per call): { json, schema, model, timeoutMs, deadlineMs, signal }
//   deadlineMs -> hard cap on the whole provider chain (null when it expires)
//   signal    -> an AbortSignal: aborting it cancels the request in flight and ends the chain
//                (null). For background work nobody waits on any more (a timed-out AI review)
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

// True when some available provider can read images (scale photos, pill bottles).
export function visionEnabled() {
  enabled();
  return providers.some((p) => p.vision);
}

// A JSON answer about an image ({ base64, mime }). Only vision-capable providers are tried.
export function completeVisionJSON(system, user, image, opts = {}) {
  return completeJSON(system, user, { ...opts, image });
}

// Test hooks
// Use these providers ({ name, model, chat(opts) }) as the chain, without probing.
export function _use(list) {
  providers = list;
  probedAt = Date.now();
}
export function _reset() {
  coolingUntil.clear();
  failures = 0;
  openUntil = 0;
  providers = [];
  probedAt = 0;
  probing = null;
}
