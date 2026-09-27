// Buttons for channels that only carry text (SMS, WhatsApp without templates).
// Each button becomes a numbered line; we remember the last set sent to that phone,
// so a reply of "2" comes back to the core as that button's `data`, exactly like a tap.
import * as store from '../store.js';
import * as clock from '../core/clock.js';

const TTL_MS = 24 * clock.HOUR; // an old menu shouldn't turn tomorrow's "1" into an answer
const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

// "whatsapp:+1 (404) 555-0100" -> "+14045550100"
export const normalizePhone = (raw) => {
  const s = String(raw ?? '').replace(/^whatsapp:/i, '').trim();
  const digits = s.replace(/[^\d]/g, '');
  return digits ? `${s.startsWith('+') ? '+' : ''}${digits}` : null;
};

// Language-neutral on purpose (keycap + label): no English to translate.
export function renderNumbered(reply) {
  const options = reply.buttons?.flat() ?? [];
  if (!options.length) return { body: reply.text, options: [] };
  const lines = options.map((b, i) => `${KEYCAPS[i] ?? `${i + 1}.`} ${b.label}`);
  return { body: `${reply.text}\n\n${lines.join('\n')}`, options };
}

const table = () => store.collection('channel_options');

// Newest menu wins; sends without buttons leave the last menu in place (a question
// is often followed by a plain tip, and "2" should still mean the question's option 2).
export function remember(phone, options) {
  const key = normalizePhone(phone);
  if (!key || !options?.length) return;
  const rows = table();
  const i = rows.findIndex((r) => r.phone === key);
  const row = { phone: key, options: options.map((b) => ({ label: b.label, data: b.data })), ts: clock.nowISO() };
  if (i >= 0) rows[i] = row;
  else rows.push(row);
  store.persist();
}

// "2" / " 2 " / "2." -> the data of option 2, if a fresh menu exists and 2 is in range.
export function resolve(phone, text) {
  const m = String(text ?? '').trim().match(/^(\d{1,2})[.)]?$/);
  if (!m) return null;
  const row = table().find((r) => r.phone === normalizePhone(phone));
  if (!row || clock.now() - Date.parse(row.ts) > TTL_MS) return null;
  return row.options[Number(m[1]) - 1] ?? null;
}
