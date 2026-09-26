// Claude via the official SDK. Selected whenever ANTHROPIC_API_KEY is set.
import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'; // fast + cheap; plenty for extraction/translation

export function detect() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const client = new Anthropic();
  return {
    name: 'claude',
    model,
    async chat({ system, user, maxTokens }) {
      const res = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      });
      return res.content.find((b) => b.type === 'text')?.text ?? '';
    },
  };
}
