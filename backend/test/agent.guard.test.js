// A handler failure must not leave the patient with silence or a 500 (audit 2026-10-11: a malformed
// model answer in the companion threw "filter is not a function" and the API returned 500).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-guard-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';

let store, agent;
before(async () => {
  store = await import('../src/store.js');
  agent = await import('../src/core/agent.js');
});

test('a throwing handler returns "didn\'t catch that" + the 911 line and leaves an audit entry', async () => {
  // A patient record with a broken shape makes the check-in start throw inside the handler.
  store.updatePatient('p5', { meds: null, checkin: { state: 'weight', answers: null, startedAt: new Date().toISOString() } });
  const replies = await agent.handleInbound({ patientId: 'p5', text: '170', channel: 'sim' });
  assert.ok(replies[0].text.includes('911'), replies[0].text);
  assert.ok(store.listAudit('p5').some((e) => e.type === 'handler_error'));
});
