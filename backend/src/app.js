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
import * as sec from './security.js'; // auth, demo gating, CORS, rate limits, error handler

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(sec.securityHeaders);
  app.use(cors(sec.corsOptions));
  // Photos arrive as base64 on the simulate route only; every other JSON body is capped small.
  app.use('/api/patients/:id/simulate', express.json({ limit: '10mb' }));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' })); // Twilio webhooks are form-encoded
  app.use('/api', sec.apiAuth);
  // Destructive demo controls exist in dev / DEMO_MODE=1 only.
  app.use(['/api/demo', '/api/reset', '/api/insights/cohort/regenerate'], sec.demoOnly);
  app.use('/api/fhir', sec.rateLimit({ name: 'fhir', max: 30 }));
  app.use('/api/devices/readings', sec.rateLimit({ name: 'readings', max: 120 }));
  app.use('/webhooks', sec.rateLimit({ name: 'webhooks', max: 120 }));
  app.use('/api/demo', demo);
  app.use('/api/insights', insights);
  app.use('/api/fhir', fhir);
  app.use('/api/join', join);
  app.use('/api', api);
  app.use('/webhooks', webhooks);
  app.use('/api', sec.notFound);
  app.use(sec.errorHandler);
  return app;
}
