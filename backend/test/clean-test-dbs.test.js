import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { cleanTestDbs } = await import('../tools/clean-test-dbs.js');

test('removes old heartbridge test databases (and siblings) but not new ones or anyone else\'s files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleaner-'));
  const make = (name, ageMs, isDir = false) => {
    const full = path.join(dir, name);
    if (isDir) {
      fs.mkdirSync(full);
      fs.writeFileSync(path.join(full, 'db.json'), '{}');
    } else fs.writeFileSync(full, '{}');
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(full, t, t);
  };
  const HOUR = 3600_000;
  make('heartbridge-old-1.json', 3 * HOUR);
  make('heartbridge-old-1.json.bak', 3 * HOUR);
  make('heartbridge-old-2.json.corrupt', 3 * HOUR);
  make('heartbridge-old-3.json.12345.tmp', 3 * HOUR);
  make('heartbridge-durable-abc', 3 * HOUR, true);
  make('heartbridge-new.json', 60_000);
  make('someone-elses.json', 3 * HOUR);
  make('heartbridge.txt', 3 * HOUR);
  const removed = cleanTestDbs(dir, HOUR);
  assert.equal(removed, 5);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['heartbridge-new.json', 'heartbridge.txt', 'someone-elses.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing or empty folder is not an error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleaner-'));
  assert.equal(cleanTestDbs(dir), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
