// ============================================================================
// Telegram channel — OWNER: Telegram teammate. See docs/TELEGRAM_SETUP.md.
//
// Responsibilities (and nothing else — no clinical logic here):
//   1. /start <CODE>      -> store.linkChat(code, chatId), send welcome
//   2. text / voice notes -> store.findByChatId -> agent.handleInbound -> render replies
//   3. button taps        -> answerCallbackQuery, agent.handleInbound({ buttonData })
//   4. sendToChat()       -> used by core for proactive check-ins, reminders, alerts
//
// Uses long polling (bot.start()), so no public URL / ngrok is needed.
// ============================================================================
import { Bot, InlineKeyboard } from 'grammy';
import * as store from '../store.js';
import { handleInbound } from '../core/agent.js';

let bot = null;

export const isEnabled = () => bot !== null;

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

export async function sendToChat(chatId, { text, buttons }) {
  if (!bot) throw new Error('Telegram bot not started');
  return bot.api.sendMessage(chatId, text, { reply_markup: toKeyboard(buttons) });
}

export function start() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN not set — bot disabled (dashboard still works).');
    return;
  }
  bot = new Bot(token);

  // --- 1. Linking: t.me/<bot>?start=GARCIA1 arrives as "/start GARCIA1" ---
  bot.command('start', async (ctx) => {
    const code = ctx.match; // text after /start
    const link = store.linkChat(code, ctx.chat.id);
    if (!link) {
      return ctx.reply('Welcome to HeartBridge 💙 Please open the link your care team gave you (or send /start YOURCODE).');
    }
    // TODO(telegram): welcome in patient.language (see core/i18n.js once it exists)
    const who = link.role === 'caregiver' ? `caregiver for ${link.patient.name}` : link.patient.name;
    await ctx.reply(`✅ Linked as ${who}. You'll get daily check-ins here.`);
  });

  // --- 2. Free text from a linked patient ---
  bot.on('message:text', async (ctx) => {
    const link = store.findByChatId(ctx.chat.id);
    if (!link) return ctx.reply('Please send /start YOURCODE first.');
    if (link.role !== 'patient') return ctx.reply('Thanks! You will receive alerts and weekly updates here.');
    const replies = await handleInbound({ patientId: link.patient.id, text: ctx.message.text });
    for (const r of replies) await ctx.reply(r.text, { reply_markup: toKeyboard(r.buttons) });
  });

  // --- 3. Inline button taps ---
  bot.on('callback_query:data', async (ctx) => {
    await ctx.answerCallbackQuery();
    const link = store.findByChatId(ctx.chat.id);
    if (!link || link.role !== 'patient') return;
    const replies = await handleInbound({ patientId: link.patient.id, buttonData: ctx.callbackQuery.data });
    for (const r of replies) await ctx.reply(r.text, { reply_markup: toKeyboard(r.buttons) });
  });

  // TODO(telegram): voice notes (stretch) — bot.on('message:voice'):
  //   ctx.getFile() -> download -> Groq Whisper -> handleInbound({ voiceTranscript })
  //   optionally reply with TTS audio via google-tts-api + ctx.replyWithAudio
  // TODO(telegram): /checkin, /meds, /help commands
  // TODO(telegram): log ctx.chat.id for group messages so we can find NURSE_CHAT_ID

  bot.catch((err) => console.error('[telegram] error:', err.error?.message ?? err));
  bot.start({ onStart: (me) => console.log(`[telegram] @${me.username} polling`) });
}

export async function stop() {
  await bot?.stop();
}
