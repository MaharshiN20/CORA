import http from 'node:http';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { events } from './store.js';
import * as telegram from './channels/telegram.js';
import * as llm from './core/llm/index.js';

const server = http.createServer(createApp());
const io = new Server(server, { cors: { origin: '*' } });

// Push every store change to the dashboard so it updates live.
events.on('change', (evt) => io.emit('change', evt));

const PORT = Number(process.env.PORT) || 3001;
server.listen(PORT, () => console.log(`[api] http://localhost:${PORT}/api/health`));

telegram.start();
await llm.detect({ force: true });
const ai = llm.status();
console.log(`[llm] using ${ai.provider}${ai.model ? ` (${ai.model})` : ' — rule fallbacks only'}`);
setInterval(() => llm.detect().catch(() => {}), 60_000).unref();
// TODO(core P1-2): scheduler.start() — daily check-ins, med reminders, refill checks, outreach ladder
