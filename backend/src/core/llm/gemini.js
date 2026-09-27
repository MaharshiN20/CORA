// Google Gemini via its OpenAI-compatible endpoint. Selected when GEMINI_API_KEY is set.
// Default model is the stable alias `gemini-flash-latest` (fixed versions get retired for
// new keys: gemini-2.5-flash already returns 404 "no longer available to new users").
import { makeProvider } from './openaiCompat.js';

const DEFAULT_MODEL = 'gemini-flash-latest';
const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

export function detect() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const base = (process.env.GEMINI_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  return makeProvider('gemini', `${base}/chat/completions`, model, {
    headers: { Authorization: `Bearer ${key}` },
    accepts: (m) => /^gemini/i.test(m), // a per-call override like RISK_MODEL=qwen... never reaches Gemini
  });
}
