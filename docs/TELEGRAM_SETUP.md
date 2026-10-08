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

> **Superseded:** the current, detailed task list is **[docs/team/KRISH.md](team/KRISH.md)**. The items below are kept for reference.

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

- In webhook mode (§9) a `403` on `/webhooks/telegram` means the secret header doesn't match `TELEGRAM_WEBHOOK_SECRET`; a `404` means `TELEGRAM_WEBHOOK_URL` isn't set in that process.

## 8. SMS & WhatsApp (Twilio)

Same agent, same check-in, no app to install. Useful for patients who don't have Telegram, and it's the channel a hospital would run behind a BAA (the "HIPAA path"). Everything is optional: with no Twilio variables set, the adapters stay disabled and nothing else changes.

**How it works**
- Outbound: `channels/index.js` sends on `patient.channel` (`telegram` | `sms` | `whatsapp`) and falls back to any other enabled channel the person has an address for (`chatId` or `phone`).
- Buttons become numbered lines (`1️⃣ 😊 Normal`). A reply of `2` is turned back into that button's data, so the core can't tell SMS from a tap. Menus are remembered per phone for 24 h.
- Inbound: `POST /webhooks/twilio/sms` and `/webhooks/twilio/whatsapp`. Texting `JOIN GARCIA1` links a phone to a patient, `JOIN CG_GARCIA1` links a caregiver, and `JOIN DEMO_ES` is judge mode. WhatsApp images and voice notes work too (photo → core, voice → Whisper).
- Replies go out through the REST API and the webhook returns empty TwiML. If the REST call fails, or no credentials are set, the replies come back inside the TwiML instead.

**Trial setup (about 10 minutes, free trial credit)**
1. Sign up at https://www.twilio.com/try-twilio. From the Console home, copy the **Account SID** and **Auth Token** into `backend/.env`.
2. **SMS:** Phone Numbers → Buy a number (trial credit covers it) → `TWILIO_SMS_FROM=+1...`. Trial accounts can only text **verified** numbers: Phone Numbers → Verified Caller IDs → add each demo phone.
3. **WhatsApp sandbox:** Messaging → Try it out → Send a WhatsApp message. Each demo phone sends the sandbox's `join <two-words>` message to **+1 415 523 8886** once. Set `TWILIO_WHATSAPP_FROM=whatsapp:+14155238886`.
4. Expose the backend: `ngrok http 3001`, then set `PUBLIC_URL=https://<id>.ngrok.app` in `.env` (the signature check needs the exact public URL).
5. Point Twilio at it:
   - SMS: Phone Numbers → your number → Messaging → "A message comes in" → Webhook, `POST https://<id>.ngrok.app/webhooks/twilio/sms`
   - WhatsApp: Sandbox settings → "When a message comes in" → `POST https://<id>.ngrok.app/webhooks/twilio/whatsapp`
6. Restart the backend. `GET /webhooks` should show `{ sms: true, whatsapp: true, signatureCheck: true }`. Text `JOIN GARCIA1` to try it.

**Gotchas**
- Requests are rejected with 403 when `TWILIO_AUTH_TOKEN` is set and the signature doesn't match. That's almost always a wrong or missing `PUBLIC_URL` (http vs https, or a stale ngrok id).
- Trial messages start with "Sent from your Twilio trial account".
- The WhatsApp sandbox forgets a phone after 72 h without messages; resend the `join` words.
- Try it locally without Twilio (replies come back as TwiML): `curl --data-urlencode "From=+14045550100" --data-urlencode "Body=JOIN GARCIA1" localhost:3001/webhooks/twilio/sms`

## 9. Webhook mode (production)

Long polling (§2) stays the default and is what you want on a laptop. A deployed server should use a webhook instead: Telegram calls us, nothing holds a connection open, several instances can sit behind one address, and Telegram re-sends anything we didn't acknowledge.

**Turn it on**
```bash
TELEGRAM_WEBHOOK_URL=https://hb.example.org      # public HTTPS base URL (or the full .../webhooks/telegram)
TELEGRAM_WEBHOOK_SECRET=<random string>          # A-Z a-z 0-9 _ - only, up to 256 characters
```
Generate a secret with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. On start the backend calls `setWebhook` with that URL and secret and logs `[telegram] @your_bot webhook -> https://…/webhooks/telegram`. It does not poll in this mode.

**What the endpoint does** (`POST /webhooks/telegram`)
- Every request must carry the secret in the `X-Telegram-Bot-Api-Secret-Token` header (Telegram adds it). Anything else gets `403`, compared in constant time.
- Each `update_id` is handled once. Telegram re-sends an update when our answer was slow or lost; the repeat is acknowledged with `200` and ignored (remembered for 10 minutes).
- A handler error is logged and still answered `200`, the same as polling, so Telegram doesn't keep re-sending one bad update and hold up that chat.
- Only `message`, `callback_query` and `my_chat_member` updates are requested.

**Fails closed**
- `NODE_ENV=production` with a URL but no secret: the webhook is not registered, every request gets `403`, and the log says why. Incoming Telegram messages are off until it's fixed; sending and the dashboard keep working.
- A URL that isn't `https://`, or a secret with characters Telegram rejects, is refused the same way (in any environment).
- Outside production a missing secret is allowed with a warning, like the Twilio check.

**Switching back and shutting down**
- Unset `TELEGRAM_WEBHOOK_URL` and restart: polling removes the webhook by itself.
- A normal shutdown leaves the webhook registered on purpose, so Telegram keeps what arrives during a restart and delivers it afterwards. To really unregister, call `telegram.stop({ deleteWebhook: true })`, or `curl https://api.telegram.org/bot<TOKEN>/deleteWebhook`.
- Check what Telegram has on file: `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo` (look at `url`, `pending_update_count` and `last_error_message`).

**Try it locally** with ngrok: `ngrok http 3001`, set `TELEGRAM_WEBHOOK_URL=https://<id>.ngrok.app` and a secret, restart, message the bot. Only one mode works per token at a time: while a webhook is registered, another process polling the same token removes it.
