// Local models through the OpenAI-compatible /v1/chat/completions endpoint.
// Both Ollama and LM Studio speak it, so one adapter covers both; they differ
// only in how we discover which models are available.

const PROBE_TIMEOUT_MS = 1500;
const CALL_TIMEOUT_MS = 60_000; // local models on a laptop can be slow

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

function makeProvider(name, baseUrl, model) {
  async function call({ system, user, maxTokens, json }) {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.2,
        messages: [
          { role: 'system', content: NO_THINK.test(model) ? `${system}\n/no_think` : system },
          { role: 'user', content: user },
        ],
        ...(json && { response_format: JSON_FORMAT[name] }),
      }),
    });
    if (!res.ok) throw new Error(`${name} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const choice = (await res.json()).choices?.[0];
    return { text: stripThinking(choice?.message?.content ?? ''), truncated: choice?.finish_reason === 'length' };
  }

  return {
    name,
    model,
    async chat(opts) {
      const first = await call(opts);
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
    const model = process.env.OLLAMA_MODEL || pickModel(models.map((m) => m.name));
    return model ? makeProvider('ollama', base, model) : null;
  } catch {
    return null;
  }
}

// LM Studio lists loaded models at /v1/models -> { data: [{ id }] }
export async function detectLmStudio() {
  const base = (process.env.LMSTUDIO_URL || 'http://localhost:1234').replace(/\/$/, '');
  try {
    const { data = [] } = await getJSON(`${base}/v1/models`);
    const model = process.env.LMSTUDIO_MODEL || pickModel(data.map((m) => m.id));
    return model ? makeProvider('lmstudio', base, model) : null;
  } catch {
    return null;
  }
}
