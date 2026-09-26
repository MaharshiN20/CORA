// Kept so existing `import * as llm from './llm.js'` callers don't change.
// Implementation lives in ./llm/ (provider chain: Claude -> Ollama -> LM Studio).
export * from './llm/index.js';
