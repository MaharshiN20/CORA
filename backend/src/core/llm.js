// Optional Claude helper. Everything that calls this MUST have a non-LLM fallback:
// if there's no key or the call fails, these return null and callers carry on.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-haiku-4-5-20251001'; // fast + cheap; plenty for extraction/translation
let client = null;

export const enabled = () => !!process.env.ANTHROPIC_API_KEY;

function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

export async function complete(system, user, maxTokens = 400) {
  if (!enabled()) return null;
  try {
    const res = await getClient().messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });
    return res.content.find((b) => b.type === 'text')?.text?.trim() ?? null;
  } catch (err) {
    console.error('[llm] call failed, falling back:', err.message);
    return null;
  }
}

// Returns parsed JSON or null.
export async function completeJSON(system, user) {
  const text = await complete(`${system}\nRespond with ONLY a JSON object, no prose.`, user);
  if (!text) return null;
  try {
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
}
