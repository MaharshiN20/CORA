# Telegram Setup Guide (100% free)

Owner: **Telegram teammate**. Your file: `backend/src/channels/telegram.js`.
Everything clinical (check-ins, triage, alerts) lives in `backend/src/core/`. You never need to touch it: you pass messages in and render what comes back.

---

## 1. Create your bot (5 min)

1. Install Telegram (phone or desktop) and open a chat with **@BotFather** (it has a blue check mark).
2. Send `/newbot`.
   - **Name**: anything, e.g. `HeartBridge Dev (Alex)`
   - **Username**: must end in `bot`, e.g. `heartbridge_alex_bot`
3. BotFather replies with a **token** like `7123456789:AAH...`. Treat it like a password.
4. Optional polish (only for the demo bot):
   - `/setdescription` → "Your heart-health check-in buddy after hospital discharge 💙"
   - `/setuserpic` → upload a logo
   - `/setcommands` → paste:
     ```
     start - Link your account
     checkin - Start today's check-in
     meds - Medication reminders
     help - How this works
     ```

> **Each dev needs their own bot token.** Telegram only allows one process to long-poll a token, so if two laptops share a token, messages get split randomly between them. Make one "demo" bot for the final presentation.

## 2. Run it locally

```bash
cd backend
cp .env.example .env        # then paste TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME
npm install
npm run dev                 # expect: "[telegram] @your_bot polling"
```

We use **long polling** (`bot.start()`), so you don't need ngrok, a public URL or hosting. It works on venue Wi-Fi from a laptop.

## 3. Try it right away

Open `https://t.me/<your_bot_username>?start=GARCIA1` on your phone and press **Start**.
You're now linked as the demo patient Maria Garcia. Send any text and the bot offers a check-in. Tap through it (buttons + free text both work). Try "chest pain" to see a RED escalation.

Demo link codes (from `backend/src/seed.js`):

| Patient | Code | Caregiver code |
|---|---|---|
| Maria Garcia (es, high risk, hero) | `GARCIA1` | `CG_GARCIA1` |
| Robert Johnson (en) | `JOHNSON1` | `CG_JOHNSON1` |
| Thanh Nguyen (vi) | `NGUYEN1` | `CG_NGUYEN1` |
| Anil Patel (hi) | `PATEL1` | `CG_PATEL1` |
| Dorothy Smith (en) | `SMITH1` | `CG_SMITH1` |

Open the nurse dashboard (`cd frontend && npm run dev` → http://localhost:5173) to watch messages show up live.

Reset everything: `cd backend && npm run seed` (or the "Reset demo" button).

## 4. The contract (don't break this)

```js
// Inbound: you call this
import { handleInbound } from '../core/agent.js';
const replies = await handleInbound({ patientId, text, buttonData, voiceTranscript });
// replies: [{ text: string, buttons?: [[{ label, data }]] }]  // rows of buttons

// Outbound: core calls this for proactive messages (check-ins, reminders, alerts)
export async function sendToChat(chatId, { text, buttons }) { ... }

// Linking
store.linkChat(code, chatId)      // -> { role: 'patient'|'caregiver', patient } | null
store.findByChatId(chatId)        // -> { role, patient } | null
```

Button `data` is at most **64 bytes** (a Telegram limit). The core keeps it short, like `ci:breath:rest`.

Replies may also include `textEn` (English copy for the dashboard). Ignore it when sending to Telegram.

## 5. Your task list

The skeleton already handles `/start CODE`, text, button taps and `sendToChat`. Build on it:

- [ ] **Verify basics**: link, text round-trip, button taps (tap → `answerCallbackQuery` so the spinner stops)
- [ ] **Nicer button UX**: after a tap, edit the original message to show the choice and remove the keyboard (`ctx.editMessageReplyMarkup()`), so people can't double-tap
- [ ] **Welcome message in the patient's language** (`patient.language`: `en`, `es`, `vi`, `hi`). Use `t(patient.language, key, vars)` from `core/i18n.js` (add a `welcome` key there in en + es)
- [ ] **Commands**: `/checkin` → call `startCheckin(patientId)` from `core/agent.js` and send the replies. `/help` → short explainer
- [ ] **Nurse group**: create a Telegram group "HeartBridge Care Team", add the bot, send a message, then log `ctx.chat.id` (a negative number) → put it in `.env` as `NURSE_CHAT_ID`. Core's `channels.sendToNurses()` already posts there. In BotFather, `/setprivacy` → Disable if you need the bot to see all group messages
- [ ] **Caregiver chat**: `/start CG_GARCIA1` links a caregiver. Make sure caregiver texts get a friendly "you'll receive alerts here" reply
- [ ] **Formatting**: send alerts with `parse_mode: 'HTML'` (bold tier, emoji). RED alerts should look urgent 🚨
- [ ] **Stretch: voice-first** (below)

## 6. Stretch: voice notes (free)

Voice matters for elderly and low-literacy patients, and it sets us apart in judging.

**Inbound (speech → text)**, using the **Groq free tier** (runs Whisper, no credit card):
1. Sign up at https://console.groq.com → API Keys → put the key in `.env` as `GROQ_API_KEY`
2. In `telegram.js`:
   ```js
   bot.on('message:voice', async (ctx) => {
     const file = await ctx.getFile();
     const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
     const audio = await (await fetch(url)).blob();
     const form = new FormData();
     form.append('file', audio, 'voice.ogg');
     form.append('model', 'whisper-large-v3');
     const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
       method: 'POST',
       headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
       body: form,
     });
     const { text } = await r.json();
     // then handleInbound({ patientId, voiceTranscript: text }) and reply
   });
   ```
   Telegram voice notes are OGG/Opus, which Whisper accepts as-is. Whisper auto-detects Spanish, Hindi, Vietnamese and more.

**Outbound (text → speech)** with `npm i google-tts-api` (free, no key):
```js
import googleTTS from 'google-tts-api';
const url = googleTTS.getAudioUrl(text, { lang: patient.language, slow: true }); // text <= 200 chars
await ctx.replyWithAudio(url); // Telegram fetches the URL itself
```
For longer text use `googleTTS.getAllAudioUrls` and send them in sequence. A per-patient `voiceMode` flag can decide whether to reply with voice.

## 7. Gotchas

- **Bots can't message someone first.** Every demo phone (patient, caregiver) must open its deep link and press Start **before** the demo.
- Rate limit is about 30 msgs/sec overall and 1 msg/sec per chat. That's not an issue for us.
- `409 Conflict: terminated by other getUpdates request` means another process is polling the same token. Kill it or use your own token.
- Don't commit `.env`.
- Docs: https://grammy.dev (guide), https://core.telegram.org/bots/api (reference).
