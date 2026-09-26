// Judge-mode join links (Krish lane). Mounted at /api/join.
// GET /api/join -> { bot, links: [{ language, name, nativeName, url }] }
// The frontend Join/Demo pages (Maharshi) render these as QR codes.
import { Router } from 'express';
import { languages } from '../core/enroll.js';

export const join = Router();

join.get('/', (_req, res) => {
  const bot = process.env.TELEGRAM_BOT_USERNAME || null;
  const links = languages().map((l) => ({
    language: l.code,
    name: l.name,
    nativeName: l.nativeName,
    // /start DEMO_<lang> -> telegram.js calls enrollDemoPatient({ language })
    url: bot ? `https://t.me/${bot}?start=DEMO_${l.code.toUpperCase()}` : null,
  }));
  res.json({ bot, links });
});
