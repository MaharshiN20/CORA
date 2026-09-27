// Offline Telegram harness (not a test file itself). Builds a bot with a preset identity
// (so grammY never calls getMe) and a transformer that records every API call instead
// of sending it. Import AFTER setting HEARTBRIDGE_DB / LLM_PROVIDER.
import { buildBot } from '../src/channels/telegram.js';

export const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: 'HB',
  username: 'hb_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

let updateId = 0;
let messageId = 100;

export function makeBot({ results = {} } = {}) {
  const bot = buildBot('test:token', { botInfo: BOT_INFO });
  const calls = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    const custom = results[method];
    if (custom) return { ok: true, result: typeof custom === 'function' ? custom(payload) : custom };
    return { ok: true, result: fakeResultFor(method, payload) };
  });
  return { bot, calls };
}

function fakeResultFor(method, payload) {
  if (method === 'sendMessage' || method === 'sendVoice' || method === 'sendAudio') {
    return { message_id: ++messageId, date: 0, chat: { id: payload.chat_id, type: 'private' }, text: payload.text };
  }
  return true;
}

const from = (chatId, extra) => ({ id: chatId, is_bot: false, first_name: 'Maria', ...extra });

export function textUpdate(chatId, text, { chatType = 'private', languageCode } = {}) {
  const message = {
    message_id: ++messageId,
    date: 0,
    chat: { id: chatId, type: chatType, ...(chatType !== 'private' && { title: 'Nurses' }) },
    from: from(chatId, languageCode && { language_code: languageCode }),
    text,
  };
  const cmd = text.match(/^\/\w+/);
  if (cmd) message.entities = [{ type: 'bot_command', offset: 0, length: cmd[0].length }];
  return { update_id: ++updateId, message };
}

// A tap on `data` in a message we previously sent (pass the recorded sendMessage payload).
export function tapUpdate(chatId, data, sent) {
  const keyboard = sent?.reply_markup?.inline_keyboard ?? [];
  return {
    update_id: ++updateId,
    callback_query: {
      id: String(++updateId),
      from: from(chatId),
      chat_instance: '1',
      data,
      message: {
        message_id: ++messageId,
        date: 0,
        chat: { id: chatId, type: 'private' },
        text: sent?.text ?? '',
        reply_markup: { inline_keyboard: keyboard.map((row) => row.map((b) => ({ text: b.text, callback_data: b.callback_data }))) },
      },
    },
  };
}

export const sent = (calls, method = 'sendMessage') => calls.filter((c) => c.method === method).map((c) => c.payload);
export const lastSent = (calls) => sent(calls).at(-1);

// The most recent sent message that carries a button with this callback data.
export function messageWithButton(calls, data) {
  return sent(calls)
    .reverse()
    .find((p) => p.reply_markup?.inline_keyboard?.flat().some((b) => b.callback_data === data));
}
