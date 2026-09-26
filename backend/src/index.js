import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { api } from './routes/api.js';
import { events } from './store.js';
import * as telegram from './channels/telegram.js';

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', api);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Push every store change to the dashboard so it updates live.
events.on('change', (evt) => io.emit('change', evt));

const PORT = Number(process.env.PORT) || 3001;
server.listen(PORT, () => console.log(`[api] http://localhost:${PORT}/api/health`));

telegram.start();
// TODO(core): scheduler.start() — daily check-ins, med reminders, refill checks
