// Express app with every lane's router mounted. Split from index.js so tests can
// import the app without starting the server, Telegram or the scheduler.
//
// Adding a router? Mount it here with ONE line (shared file, additive changes only).
import express from 'express';
import cors from 'cors';
import { api } from './routes/api.js'; // Prannav: core
import { demo } from './routes/demo.js'; // Prannav: demo console
import { insights } from './routes/insights.js'; // Maharshi: analytics
import { fhir } from './routes/fhir.js'; // Maharshi: EHR import
import { join } from './routes/join.js'; // Krish: judge-mode links
import { webhooks } from './routes/webhooks.js'; // Krish: SMS/WhatsApp inbound

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' })); // photos arrive as base64
  app.use(express.urlencoded({ extended: false })); // Twilio webhooks are form-encoded
  app.use('/api/demo', demo);
  app.use('/api/insights', insights);
  app.use('/api/fhir', fhir);
  app.use('/api/join', join);
  app.use('/api', api);
  app.use('/webhooks', webhooks);
  return app;
}
