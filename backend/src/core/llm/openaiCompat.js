// Providers that speak the OpenAI-compatible /chat/completions API: Ollama and LM Studio
// (local, discovered by probing) and Gemini (gemini.js). One adapter covers them all.

const PROBE_TIMEOUT_MS = 1500;
const CALL_TIMEOUT_MS = 60_000; // local models on a laptop can be slow
const RETRY_DELAY_MS = Number(process.env.LLM_RETRY_DELAY_MS ?? 800);

// Prefer instruct models that handle JSON + multilingual text well.
const PREFERRED = [/qwen/i, /llama-?3/i, /gemma/i, /mistral/i, /phi/i];
const SKIP = /embed|whisper|vision-only|clip/i;

export function pickModel(ids) {
  const usable = ids.filter((id) => !SKIP.test(id));
  for (const re of PREFERRED) {
    const hit = usable.find((id) => re.test(id));
    if (hit) return hit;
  }
  return usable[0] ?? null;
}

async function getJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

// Reasoning models (qwen3, deepseek-r1, ...) can spend the whole token budget
// "thinking" and return empty content. Qwen3 honours a /no_think switch; for the
// rest we strip <think> blocks and retry once with a bigger budget.
const NO_THINK = /qwen3/i;
const stripThinking = (s) => s.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();

// JSON mode syntax differs: Ollama takes json_object, LM Studio only json_schema.
const JSON_FORMAT = {
  ollama: { type: 'json_object' },
  lmstudio: { type: 'json_schema', json_schema: { name: 'response', schema: { type: 'object' } } },
};

// JSON output: a caller-supplied schema is enforced where the server supports it.
function responseFormat(name, schema) {
  if (schema) return { type: 'json_schema', json_schema: { name: 'response', schema } };
  return JSON_FORMAT[name] ?? { type: 'json_object' };
}

// One OpenAI-compatible provider (Ollama, LM Studio, Gemini...).
//   chatUrl: full /chat/completions URL; headers: e.g. auth; models: known model ids
//   (a per-call `model` override is honoured only if this provider has that model).
// Local models that can read images (Qwen-VL, LLaVA, Gemma 3, Llama 3.2 Vision, ...).
export const VISION_MODEL = /\bvl\b|-vl|vision|llava|gemma-?3|pixtral|minicpm-v|moondream/i;

export function makeProvider(name, chatUrl, model, { headers = {}, models = [model], accepts, vision = VISION_MODEL.test(model) } = {}) {
  const canUse = accepts ?? ((m) => models.includes(m));

  async function call({ system, user, maxTokens, json, schema, model: wanted, timeoutMs, image }) {
    const useModel = wanted && canUse(wanted) ? wanted : model;
    const res = await fetch(chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      signal: AbortSignal.timeout(timeoutMs ?? CALL_TIMEOUT_MS),
      body: JSON.stringify({
        model: useModel,
        max_tokens: maxTokens,
        temperature: 0.2,
        // Turn off "thinking" on reasoning models (qwen3.5 ignores /no_think; LM Studio and
        // Gemini honour this and answer in ~1-5s instead of burning the budget). Ignored elsewhere.
        reasoning_effort: 'none',
        messages: [
          { role: 'system', content: NO_THINK.test(useModel) ? `${system}\n/no_think` : system },
          // An image (vision calls) goes as an OpenAI-style data URI next to the text.
          { role: 'user', content: image ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } }] : user },
        ],
        ...((json || schema) && { response_format: responseFormat(name, schema) }),
      }),
    });
    if (!res.ok) throw Object.assign(new Error(`${name} ${res.status}: ${(await res.text()).slice(0, 200)}`), { status: res.status });
    const body = await res.json();
    const choice = (Array.isArray(body) ? body[0] : body).choices?.[0];
    return { text: stripThinking(choice?.message?.content ?? ''), truncated: choice?.finish_reason === 'length' };
  }

  return {
    name,
    model,
    accepts: canUse,
    vision,
    async chat(opts) {
      // Hosted APIs (Gemini) return brief 503 "high demand" / 429 spikes: retry once, then
      // let the chain fall through to the next provider.
      const first = await call(opts).catch(async (err) => {
        if (err.status !== 503 && err.status !== 429) throw err;
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        return call(opts);
      });
      if (first.text || !first.truncated) return first.text;
      return (await call({ ...opts, maxTokens: opts.maxTokens * 4 })).text;
    },
  };
}

// Ollama lists models at /api/tags -> { models: [{ name }] }
export async function detectOllama() {
  const base = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
  try {
    const { models = [] } = await getJSON(`${base}/api/tags`);
    const ids = models.map((m) => m.name);
    const model = process.env.OLLAMA_MODEL || pickModel(ids);
    return model ? makeProvider('ollama', `${base}/v1/chat/completions`, model, { models: [model, ...ids] }) : null;
  } catch {
    return null;
  }
}

// LM Studio lists loaded models at /v1/models -> { data: [{ id }] }
export async function detectLmStudio() {
  const base = (process.env.LMSTUDIO_URL || 'http://localhost:1234').replace(/\/$/, '');
  try {
    const { data = [] } = await getJSON(`${base}/v1/models`);
    const ids = data.map((m) => m.id);
    const model = process.env.LMSTUDIO_MODEL || pickModel(ids);
    return model ? makeProvider('lmstudio', `${base}/v1/chat/completions`, model, { models: [model, ...ids] }) : null;
  } catch {
    return null;
  }
}
