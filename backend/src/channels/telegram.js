// ============================================================================
// Telegram channel (Krish lane). See docs/TELEGRAM_SETUP.md and docs/CONTRACTS.md §1.
//
// Responsibilities (and nothing else, no clinical logic here):
//   1. /start <CODE>      -> store.linkChat(code, chatId), welcome in the patient's language
//   2. text               -> store.findByChatId -> agent.handleInbound -> render replies
//   3. button taps        -> answerCallbackQuery, lock the tapped message, handleInbound({ buttonData })
//   4. commands           -> /checkin /help /language /voice /meds
//   5. sendToChat()       -> used by channels/index.js for proactive check-ins, reminders, alerts
//
// Handlers live in buildBot() so tests can drive a bot with fake updates and a
// transformer that swallows every API call (no network). start() is the only
// thing that talks to Telegram for real (long polling, no public URL needed).
// ============================================================================
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import * as store from '../store.js';
import { handleInbound, startCheckin } from '../core/agent.js';
import { languages, isSupportedLanguage, enrollDemoPatient } from '../core/enroll.js';
import { joinLinksText } from '../routes/join.js';
import { t, localize } from '../core/i18n.js';
import { transcribe, tts } from '../integrations/speech.js';
import * as llm from '../core/llm/index.js';
import * as clock from '../core/clock.js';
import * as twilio from './twilio.js';
import { createRateLimiter, retryTransformer, describePollingError } from './resilience.js';

let bot = null;

export const isEnabled = () => bot !== null;

// Shown in Telegram's "/" menu. Spanish variants are registered for es clients.
export const COMMANDS = {
  en: [
    { command: 'checkin', description: 'Start your daily heart check-in' },
    { command: 'meds', description: 'See your medicines' },
    { command: 'language', description: 'Change language' },
    { command: 'voice', description: 'Turn voice replies on/off' },
    { command: 'help', description: 'How HeartBridge works' },
  ],
  es: [
    { command: 'checkin', description: 'Empezar su chequeo diario' },
    { command: 'meds', description: 'Ver sus medicinas' },
    { command: 'language', description: 'Cambiar idioma' },
    { command: 'voice', description: 'Activar/desactivar respuestas de voz' },
    { command: 'help', description: 'Cómo funciona HeartBridge' },
  ],
};

export const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Reply.buttons ([[{label, data}]]) -> grammY InlineKeyboard
function toKeyboard(buttons) {
  if (!buttons?.length) return undefined;
  const kb = new InlineKeyboard();
  buttons.forEach((row, i) => {
    row.forEach((b) => kb.text(b.label, b.data));
    if (i < buttons.length - 1) kb.row();
  });
  return kb;
}

// One Reply -> Telegram message(s). Urgent replies are bold + 🚨 and pinned (best effort),
// which needs HTML mode, so the text is escaped: it can echo what the patient typed.
// voice: the text always goes first; the audio is a bonus and can't block it.
export async function renderReply(api, chatId, reply, { language = 'en' } = {}) {
  const sent = await sendText(api, chatId, reply);
  if (reply.voice) await sendVoice(api, chatId, reply.text, language);
  return sent;
}

async function sendText(api, chatId, reply) {
  const reply_markup = toKeyboard(reply.buttons);
  if (!reply.urgent) return api.sendMessage(chatId, reply.text, { reply_markup });
  const text = reply.text.startsWith('🚨') ? reply.text : `🚨 ${reply.text}`;
  const sent = await api.sendMessage(chatId, `<b>${escapeHtml(text)}</b>`, { parse_mode: 'HTML', reply_markup });
  await api.pinChatMessage(chatId, sent.message_id).catch(() => {}); // not allowed in every chat
  return sent;
}

async function sendVoice(api, chatId, text, language) {
  const audio = await tts(text, language);
  if (!audio) return;
  try {
    if (audio.buffer) return await api.sendAudio(chatId, new InputFile(audio.buffer, 'heartbridge.mp3'));
    try {
      return await api.sendAudio(chatId, audio.url); // Telegram fetches it itself
    } catch {
      // Telegram couldn't fetch the URL (blocked/slow): download and upload it ourselves.
      const res = await fetch(audio.url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await api.sendAudio(chatId, new InputFile(Buffer.from(await res.arrayBuffer()), 'heartbridge.mp3'));
    }
  } catch (err) {
    console.error('[telegram] voice reply failed:', err.message);
  }
}

export async function sendToChat(chatId, reply, opts) {
  if (!bot) throw new Error('Telegram bot not started');
  return renderReply(bot.api, chatId, reply, opts);
}

// Telegram bots can download files up to 20 MB; we cap lower to keep memory and uploads sane.
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export class FileTooLargeError extends Error {}

// 'HeartBridge is typing…' while the core (and maybe an AI call) works on the reply, so the
// chat never looks frozen. Fire-and-forget: it must not delay or break the reply.
function typing(ctx) {
  Promise.resolve()
    .then(() => ctx.replyWithChatAction('typing'))
    .catch(() => {});
}

// Download an incoming file (voice note, photo) into a Buffer.
async function downloadFile(ctx, declaredSize) {
  if (declaredSize > MAX_FILE_BYTES) throw new FileTooLargeError();
  const file = await ctx.getFile();
  if (file.file_size > MAX_FILE_BYTES) throw new FileTooLargeError();
  const res = await fetch(`https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`file download HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_FILE_BYTES) throw new FileTooLargeError();
  return buffer;
}

// Test hook: make sendToChat() use a bot built by buildBot() without polling.
export function useBot(b) {
  bot = b;
}

// Language for someone we can't identify yet: Telegram tells us the app's language.
const guessLang = (ctx) => (isSupportedLanguage(ctx.from?.language_code?.slice(0, 2)) ? ctx.from.language_code.slice(0, 2) : 'en');

const langOf = (link) => (link.role === 'caregiver' ? link.patient.caregiver?.language ?? 'en' : link.patient.language);

// t() + LLM translation for languages without built-in strings (falls back to English).
const say = async (lang, key, vars) => localize(lang, t(lang, key, vars));

const firstName = (patient) => patient.name.split(' ')[0];

// Messages that don't go through handleInbound still belong in the dashboard log.
function logOut(link, reply) {
  store.addMessage({
    patientId: link.patient.id,
    direction: 'out',
    to: link.role,
    text: reply.text,
    textEn: reply.textEn,
    buttons: reply.buttons,
    channel: 'telegram',
  });
}

async function replyAll(ctx, link, replies) {
  const voice = link.role === 'patient' && Boolean(link.patient.voiceMode);
  for (const r of replies) await renderReply(ctx.api, ctx.chat.id, { ...r, voice: r.voice || voice }, { language: langOf(link) });
}

async function welcome(ctx, link) {
  const lang = langOf(link);
  const key = link.role === 'caregiver' ? 'welcome_caregiver' : 'welcome_patient';
  const reply = { text: await say(lang, key, { name: firstName(link.patient) }), textEn: t('en', key, { name: firstName(link.patient) }) };
  logOut(link, reply);
  await renderReply(ctx.api, ctx.chat.id, reply);
}

// Drop every existing link for this chat (patient or caregiver) before it links to someone else.
function unlinkChat(chatId) {
  for (let link = store.findByChatId(chatId); link; link = store.findByChatId(chatId)) {
    const { patient } = link;
    if (link.role === 'caregiver') store.updatePatient(patient.id, { caregiver: { ...patient.caregiver, chatId: null } });
    else store.updatePatient(patient.id, { chatId: null });
  }
}

// The /language picker. Two per row keeps native names readable on a phone.
function languageButtons() {
  const buttons = languages().map((l) => ({ label: l.nativeName, data: `lang:${l.code}` }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return rows;
}

async function setLanguage(ctx, link, code) {
  const { patient } = link;
  if (link.role === 'caregiver') store.updatePatient(patient.id, { caregiver: { ...patient.caregiver, language: code } });
  else store.updatePatient(patient.id, { language: code });
  const name = languages().find((l) => l.code === code).nativeName;
  const reply = { text: await say(code, 'language_set', { language: name }), textEn: t('en', 'language_set', { language: name }) };
  logOut(link, reply);
  await renderReply(ctx.api, ctx.chat.id, reply);
}

// After a tap: remove the keyboard and show what was picked, so it can't be tapped twice.
async function lockTappedMessage(ctx) {
  const msg = ctx.callbackQuery.message;
  if (!msg?.text) return;
  const data = ctx.callbackQuery.data;
  const label = msg.reply_markup?.inline_keyboard?.flat().find((b) => b.callback_data === data)?.text;
  await ctx
    .editMessageText(label ? `${msg.text}\n\n→ ${label}` : msg.text, { reply_markup: { inline_keyboard: [] } })
    .catch(() => {}); // message too old / unchanged: harmless
}

// For the nurse group's /status: is everything the demo needs actually up?
export function statusText() {
  const ai = llm.status();
  const patients = store.listPatients();
  const linked = patients.filter((p) => p.chatId || p.phone).length;
  const up = Math.round(process.uptime());
  const uptime = `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`;
  const on = (x) => (x ? '✅' : '—');
  return [
    '🩺 HeartBridge status',
    `Uptime: ${uptime}`,
    `LLM: ${ai.provider}${ai.model ? ` (${ai.model})` : ''}${ai.available === false ? ' (unavailable)' : ''}`,
    `Linked patients: ${linked} of ${patients.length}`,
    `Channels: Telegram ${on(true)} · SMS ${on(twilio.sms.isEnabled())} · WhatsApp ${on(twilio.whatsapp.isEnabled())}`,
    `Demo clock: ${clock.nowISO()}`,
  ].join('\n');
}

// rateLimit: { limit, windowMs } per private chat, or false to disable.
export function buildBot(token, { botInfo, rateLimit = { limit: 20, windowMs: 60_000 } } = {}) {
  const b = new Bot(token, botInfo ? { botInfo } : undefined);
  b.api.config.use(retryTransformer());
  const seenGroups = new Set();
  const limiter = rateLimit ? createRateLimiter(rateLimit) : null;
  const throttled = new Set();

  // A stuck key or a spammer shouldn't flood the core (or the LLM bill). Over the limit the
  // update is dropped; taps are still answered so the button stops spinning.
  b.use(async (ctx, next) => {
    if (!limiter || ctx.chat?.type !== 'private') return next();
    if (limiter.hit(ctx.chat.id)) {
      throttled.delete(ctx.chat.id);
      return next();
    }
    if (!throttled.has(ctx.chat.id)) {
      throttled.add(ctx.chat.id);
      console.warn(`[telegram] chat ${ctx.chat.id} is over ${rateLimit.limit} messages/${rateLimit.windowMs / 1000}s, dropping until it slows down`);
    }
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
  });

  // Group chats: log the id once so people can find NURSE_CHAT_ID.
  b.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== 'private' && !seenGroups.has(ctx.chat.id)) {
      seenGroups.add(ctx.chat.id);
      console.log(`[telegram] group chat "${ctx.chat.title ?? ''}" id=${ctx.chat.id} (use as NURSE_CHAT_ID)`);
    }
    return next();
  });

  // Groups only get nurse-side commands; a group is never treated as a patient.
  const group = b.chatType(['group', 'supergroup']);
  const isNurseGroup = (ctx) => !process.env.NURSE_CHAT_ID || String(ctx.chat.id) === String(process.env.NURSE_CHAT_ID);

  // /demo: the judge-mode join links, so the nurse group can share them on the spot.
  group.command('demo', async (ctx) => {
    if (!isNurseGroup(ctx)) return;
    await ctx.reply(joinLinksText(), { link_preview_options: { is_disabled: true } });
  });

  group.command('status', async (ctx) => {
    if (!isNurseGroup(ctx)) return;
    await ctx.reply(statusText());
  });

  const dm = b.chatType('private');

  // --- Linking: t.me/<bot>?start=GARCIA1 arrives as "/start GARCIA1" ---
  dm.command('start', async (ctx) => {
    const code = ctx.match?.trim() ?? '';
    if (!code) {
      const existing = store.findByChatId(ctx.chat.id);
      if (existing) return welcome(ctx, existing);
      return ctx.reply(t(guessLang(ctx), 'unknown_code'));
    }

    // Judge mode: /start DEMO or /start DEMO_ES -> a fresh Maria clone, straight into a check-in.
    const demo = code.match(/^DEMO(?:_([A-Za-z]{2}))?$/i);
    if (demo) {
      unlinkChat(ctx.chat.id);
      const patient = enrollDemoPatient({ chatId: ctx.chat.id, language: demo[1]?.toLowerCase() ?? guessLang(ctx) });
      const link = { role: 'patient', patient };
      await welcome(ctx, link);
      const replies = await startCheckin(patient.id);
      for (const r of replies) logOut(link, r);
      return replyAll(ctx, link, replies);
    }

    if (!store.getPatientByCode(code.replace(/^CG_/i, ''))) return ctx.reply(t(guessLang(ctx), 'unknown_code'));
    unlinkChat(ctx.chat.id); // one chat = one person; re-linking moves it
    const link = store.linkChat(code, ctx.chat.id);
    store.audit('channel_link', link.patient.id, { channel: 'telegram', role: link.role });
    await welcome(ctx, link);
  });

  // Everything below needs a linked chat.
  const linked = (handler) => async (ctx) => {
    const link = store.findByChatId(ctx.chat.id);
    if (!link) return ctx.reply(t(guessLang(ctx), 'unknown_code'));
    return handler(ctx, link);
  };

  dm.command('help', linked(async (ctx, link) => ctx.reply(await say(langOf(link), 'help'))));

  dm.command(
    'checkin',
    linked(async (ctx, link) => {
      if (link.role !== 'patient') return ctx.reply(await say(langOf(link), 'help'));
      const replies = await startCheckin(link.patient.id);
      for (const r of replies) logOut(link, r);
      await replyAll(ctx, link, replies);
    }),
  );

  dm.command(
    'language',
    linked(async (ctx, link) => {
      await ctx.reply(await say(langOf(link), 'language_prompt'), { reply_markup: toKeyboard(languageButtons()) });
    }),
  );

  dm.command(
    'voice',
    linked(async (ctx, link) => {
      if (link.role !== 'patient') return ctx.reply(await say(langOf(link), 'help'));
      const on = !link.patient.voiceMode;
      store.updatePatient(link.patient.id, { voiceMode: on });
      await ctx.reply(await say(link.patient.language, on ? 'voice_on' : 'voice_off'));
    }),
  );

  dm.command(
    'meds',
    linked(async (ctx, link) => {
      const meds = link.patient.meds ?? [];
      const lines = meds.map((m) => `💊 ${[m.name, m.dose].filter(Boolean).join(' ')}${m.times?.length ? ` (${m.times.join(', ')})` : ''}`);
      await ctx.reply(lines.length ? lines.join('\n') : '—');
    }),
  );

  // --- Free text (patient or caregiver) ---
  dm.on(
    'message:text',
    linked(async (ctx, link) => {
      typing(ctx);
      const replies = await handleInbound({ patientId: link.patient.id, role: link.role, channel: 'telegram', text: ctx.message.text });
      await replyAll(ctx, link, replies);
    }),
  );

  // --- Voice notes: transcribe, show what we heard, then treat it like typed text ---
  dm.on(
    ['message:voice', 'message:audio'],
    linked(async (ctx, link) => {
      const lang = langOf(link);
      const media = ctx.message.voice ?? ctx.message.audio;
      let transcript = null;
      try {
        const audio = await downloadFile(ctx, media.file_size);
        transcript = await transcribe(audio, media.mime_type ?? 'audio/ogg', lang);
      } catch (err) {
        if (err instanceof FileTooLargeError) return ctx.reply(await say(lang, 'file_too_large'));
        console.error('[telegram] voice download failed:', err.message);
      }
      if (!transcript) return ctx.reply(await say(lang, 'voice_unavailable'));
      await ctx.reply(t(lang, 'heard', { text: transcript }));
      typing(ctx);
      const replies = await handleInbound({ patientId: link.patient.id, role: link.role, channel: 'telegram', voiceTranscript: transcript });
      await replyAll(ctx, link, replies);
    }),
  );

  // --- Photos (med bottles, discharge papers): hand the core base64, it decides what to do ---
  const onImage = (pick) =>
    linked(async (ctx, link) => {
      const lang = langOf(link);
      const { size, mime } = pick(ctx.message);
      let buffer;
      try {
        buffer = await downloadFile(ctx, size);
      } catch (err) {
        if (err instanceof FileTooLargeError) return ctx.reply(await say(lang, 'file_too_large'));
        console.error('[telegram] photo download failed:', err.message);
        return ctx.reply(await say(lang, 'photo_failed'));
      }
      const photo = { base64: buffer.toString('base64'), mime };
      typing(ctx);
      const replies = await handleInbound({ patientId: link.patient.id, role: link.role, channel: 'telegram', photo });
      await replyAll(ctx, link, replies);
    });

  // Telegram sends several sizes of the same photo, smallest first; ctx.getFile() fetches the largest.
  dm.on('message:photo', onImage((m) => ({ size: m.photo.at(-1).file_size, mime: 'image/jpeg' })));
  // Photos sent "as file" keep full quality and arrive as documents.
  dm.on(
    'message:document',
    async (ctx, next) => (ctx.message.document.mime_type?.startsWith('image/') ? next() : undefined),
    onImage((m) => ({ size: m.document.file_size, mime: m.document.mime_type })),
  );

  // --- Inline button taps ---
  dm.on('callback_query:data', async (ctx) => {
    // A tap can outlive its query (bot restarted, a slow reply before it): Telegram then
    // rejects the answer, but the patient's choice still has to count.
    await ctx.answerCallbackQuery().catch(() => {});
    const link = store.findByChatId(ctx.chat.id);
    if (!link) return;
    await lockTappedMessage(ctx);
    const data = ctx.callbackQuery.data;
    const lang = data.startsWith('lang:') ? data.slice(5) : null;
    if (lang && isSupportedLanguage(lang)) return setLanguage(ctx, link, lang);
    const replies = await handleInbound({ patientId: link.patient.id, role: link.role, channel: 'telegram', buttonData: data });
    await replyAll(ctx, link, replies);
  });

  b.catch((err) => console.error('[telegram] error:', err.error?.message ?? err));
  return b;
}

export async function start() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN not set, bot disabled (dashboard still works).');
    return;
  }
  bot = buildBot(token);
  try {
    await bot.api.setMyCommands(COMMANDS.en);
    await bot.api.setMyCommands(COMMANDS.es, { language_code: 'es' });
  } catch (err) {
    console.error('[telegram] setMyCommands failed:', err.message);
  }
  bot
    .start({ onStart: (me) => console.log(`[telegram] @${me.username} polling`) })
    .catch((err) => console.error(describePollingError(err)));
}

export async function stop() {
  await bot?.stop();
}
