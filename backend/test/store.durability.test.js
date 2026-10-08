import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLM_PROVIDER = 'none';

// Each case gets its own db path and a fresh copy of store.js (the ?q suffix busts the
// module cache), because the store reads HEARTBRIDGE_DB once, at import.
let n = 0;
const tmpDb = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbridge-durable-'));
  return path.join(dir, 'db.json');
};
async function openStore(file) {
  process.env.HEARTBRIDGE_DB = file;
  return import(`../src/store.js?durable=${process.pid}-${++n}`);
}
const snapshot = (name) => ({ patients: [{ id: 'p1', name, linkCode: 'ZED1', caregiver: {} }], clockOffsetMs: 0 });

test('a missing db file seeds the demo data', async () => {
  const store = await openStore(tmpDb());
  assert.ok(store.listPatients().length > 0);
});

test('a corrupt db with a good .bak recovers from the backup, not the seed', async () => {
  const file = tmpDb();
  fs.writeFileSync(file, '{"patients":[{"id":"p1","na'); // truncated mid-write
  fs.writeFileSync(`${file}.bak`, JSON.stringify(snapshot('From Backup')));
  const store = await openStore(file);
  assert.equal(store.getPatient('p1')?.name, 'From Backup');
  assert.ok(fs.existsSync(`${file}.corrupt`), 'the bad file is kept for forensics');
});

test('a corrupt db with no backup fails loudly instead of reseeding over it', async () => {
  const file = tmpDb();
  fs.writeFileSync(file, 'not json at all');
  await assert.rejects(() => openStore(file), /corrupt/i);
  assert.equal(fs.readFileSync(file, 'utf8'), 'not json at all', 'the bad file is left untouched');
});

test('flush writes atomically (no .tmp left), keeps a .bak of the previous file', async () => {
  const file = tmpDb();
  fs.writeFileSync(file, JSON.stringify(snapshot('Before')));
  const store = await openStore(file);
  store.updatePatient('p1', { name: 'After' });
  store.flush();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).patients[0].name, 'After');
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).patients[0].name, 'Before');
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('mutations are debounced: many writes become one file write', async () => {
  const file = tmpDb();
  fs.writeFileSync(file, JSON.stringify(snapshot('x')));
  const store = await openStore(file);
  for (let i = 0; i < 20; i++) store.updatePatient('p1', { name: `n${i}` });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).patients[0].name, 'x', 'not written yet');
  store.flush();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).patients[0].name, 'n19');
});
