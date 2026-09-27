// Judge-mode join links (Krish lane). Mounted at /api/join.
// GET /api/join              -> { bot, links: [{ language, name, nativeName, url }] }
// GET /api/join?format=text  -> one "Name (native): url" line per language, for printing
// The frontend Join/Demo pages (Maharshi) render these as QR codes.
import { Router } from 'express';
import { languages } from '../core/enroll.js';

// Shared with the Telegram /demo command so the group and the QR page never disagree.
export function joinLinks() {
  const bot = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, '') || null;
  const links = languages().map((l) => ({
    language: l.code,
    name: l.name,
    nativeName: l.nativeName,
    // /start DEMO_<lang> -> telegram.js calls enrollDemoPatient({ language })
    url: bot ? `https://t.me/${bot}?start=DEMO_${l.code.toUpperCase()}` : null,
  }));
  return { bot, links };
}

export function joinLinksText() {
  const { bot, links } = joinLinks();
  if (!bot) return 'Telegram is not configured (set TELEGRAM_BOT_USERNAME).';
  return links.map((l) => `${l.nativeName} (${l.name}): ${l.url}`).join('\n');
}

export const join = Router();

join.get('/', (req, res) => {
  if (req.query.format === 'text') return res.type('text/plain').send(joinLinksText());
  res.json(joinLinks());
});
