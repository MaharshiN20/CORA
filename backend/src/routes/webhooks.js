// Inbound webhooks for non-Telegram channels (Krish lane). Mounted at /webhooks.
// Planned: POST /webhooks/twilio/sms, POST /webhooks/twilio/whatsapp (see docs/team/KRISH.md)
import { Router } from 'express';

export const webhooks = Router();

webhooks.get('/', (_req, res) => res.json({ ok: true, todo: 'Krish lane: K5 SMS/WhatsApp adapters' }));
