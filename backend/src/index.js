import http from 'node:http';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { events, flush } from './store.js';
import * as telegram from './channels/telegram.js';
import * as llm from './core/llm/index.js';
import * as jobs from './core/jobs.js';
import * as sec from './security.js';
import { configWarnings } from './readiness.js';

const server = http.createServer(createApp());
const io = new Server(server, { cors: { origin: (o, cb) => sec.corsOptions.origin(o, cb) } });
io.use(sec.socketAuth);
// One line per setting that is probably not what the operator meant (src/readiness.js).
for (const w of configWarnings(process.env)) console.warn(`[config] ${w.message}`);

// Push every store change to the dashboard so it updates live.
events.on('change', (evt) => io.emit('change', evt));

const PORT = Number(process.env.PORT) || 3001;
server.listen(PORT, () => console.log(`[api] http://localhost:${PORT}/api/health`));

telegram.start();
await llm.detect({ force: true });
const ai = llm.status();
console.log(`[llm] using ${ai.provider}${ai.model ? ` (${ai.model})` : ' — rule fallbacks only'}`);
setInterval(() => llm.detect().catch(() => {}), 60_000).unref();
// Scheduler: daily check-ins (and, as features land, meds, refills, outreach, digests).
await jobs.start();
console.log('[scheduler] running (30s tick; demo clock advances run due jobs instantly)');

// Graceful shutdown: stop taking work, then flush the debounced store so nothing is lost.
let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[api] ${signal}: shutting down`);
  try {
    jobs.stop();
    await telegram.stop();
    io.close();
    server.close();
  } catch (err) {
    console.error('[api] error during shutdown:', err.message);
  } finally {
    flush();
    process.exit(0);
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig));
