// Runs the full end-to-end demo story (tools/e2e-demo.js) as part of `npm test`,
// so no lane can break the pitch path without noticing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runE2E } from '../tools/e2e-demo.js';

test('end-to-end demo story passes with no Telegram and no LLM', async () => {
  const lines = [];
  const { failed, steps } = await runE2E({ log: (l) => lines.push(l) });
  assert.equal(failed, 0, lines.join('\n'));
  assert.ok(steps.length >= 12);
});
