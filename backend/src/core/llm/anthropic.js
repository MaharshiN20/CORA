// Claude via the official SDK. Selected whenever ANTHROPIC_API_KEY is set.
import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'; // fast + cheap; plenty for extraction/translation

export function detect() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const client = new Anthropic();
  const accepts = (m) => /^claude/i.test(m);
  return {
    name: 'claude',
    model,
    accepts,
    vision: true,
    // json/schema are enforced by the prompt + JSON extraction in llm/index.js.
    async chat({ system, user, maxTokens, model: wanted, timeoutMs, image, signal }) {
      const res = await client.messages.create(
        {
          model: wanted && accepts(wanted) ? wanted : model,
          max_tokens: maxTokens,
          system,
          messages: [
            {
              role: 'user',
              content: image ? [{ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.base64 } }, { type: 'text', text: user }] : user,
            },
          ],
        },
        timeoutMs || signal ? { ...(timeoutMs && { timeout: timeoutMs }), ...(signal && { signal }) } : undefined,
      );
      return res.content.find((b) => b.type === 'text')?.text ?? '';
    },
  };
}
