// LLM provider chain: Claude -> Ollama -> LM Studio -> none.
//
// Everything that calls this MUST have a non-LLM fallback: when no provider is
// available (or every provider fails), complete()/completeJSON() return null and
// callers carry on with rules. Clinical decisions never go through here.
//
// LLM_PROVIDER=auto (default) picks the first available in chain order.
// LLM_PROVIDER=claude|ollama|lmstudio pins one; LLM_PROVIDER=none disables.
import * as anthropic from './anthropic.js';
import { detectOllama, detectLmStudio } from './openaiCompat.js';

const DETECTORS = {
  claude: async () => anthropic.detect(),
  ollama: detectOllama,
  lmstudio: detectLmStudio,
};
const CHAIN = ['claude', 'ollama', 'lmstudio'];
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

export function status() {
  const p = providers[0];
  return { provider: p?.name ?? 'none', model: p?.model ?? null, available: providers.map((x) => x.name) };
}

// Try each available provider in order; fall through on errors.
async function run(opts) {
  for (const p of await detect()) {
    try {
      const text = (await p.chat(opts))?.trim();
      if (text) return text;
    } catch (err) {
      console.error(`[llm] ${p.name} failed, trying next:`, err.message);
    }
  }
  return null;
}

export function complete(system, user, maxTokens = 400) {
  return run({ system, user, maxTokens });
}

// Returns parsed JSON or null.
export async function completeJSON(system, user) {
  const text = await run({ system: `${system}\nRespond with ONLY a JSON object, no prose.`, user, maxTokens: 400, json: true });
  if (!text) return null;
  try {
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
}

// Test hook
export function _reset() {
  providers = [];
  probedAt = 0;
  probing = null;
}
