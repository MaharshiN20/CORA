// Every test file points the store at its own heartbridge-*.json in the OS temp folder, and none of
// them delete it, so a few runs leave dozens of files (plus .bak / .tmp / .corrupt siblings and the
// durability test's folders). This removes the ones older than an hour, before the next run
// (npm `pretest`). Anything newer is left alone, so a test run that is still going is never touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OURS = /^heartbridge-[\w.-]+?(\.json(\.bak|\.tmp|\.corrupt)?)?$/;

// -> number of entries removed.
export function cleanTestDbs(dir = os.tmpdir(), olderThanMs = 60 * 60 * 1000, now = Date.now()) {
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!OURS.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs < olderThanMs) continue;
      fs.rmSync(full, { recursive: stat.isDirectory(), force: true });
      removed++;
    } catch {
      /* in use or already gone: fine */
    }
  }
  return removed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const n = cleanTestDbs();
  if (n) console.log(`[clean-test-dbs] removed ${n} old test database file(s) from ${os.tmpdir()}`);
}
