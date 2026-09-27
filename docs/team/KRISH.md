# Lane K: Krish's Claude, channels & patient experience

**You own:** `backend/src/channels/**`, `backend/src/integrations/speech.js`, `backend/src/integrations/devices.js`, `backend/src/routes/webhooks.js`, `backend/src/routes/join.js`, `backend/tools/virtual-*.js`, and tests named `backend/test/channels*.test.js`, `speech*.test.js`, `webhooks*.test.js`, `devices*.test.js`.
**Read first:** `CLAUDE.md` (team rules + the per-task loop), `docs/STRATEGY.md`, `docs/CONTRACTS.md` §1, `docs/TELEGRAM_SETUP.md`, and the current `backend/src/channels/telegram.js`.

**Mission:** make the patient side feel effortless for a 78-year-old Spanish speaker, a caregiver, and a judge scanning a QR code. Every channel feature must work with no keys (skip cleanly) and be covered by tests that never touch the network.

### How to test Telegram without the network (use this everywhere)
- Create the bot with a preset identity so grammY never calls `getMe`: `new Bot('test:token', { botInfo: { id: 1, is_bot: true, first_name: 'HB', username: 'hb_test_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } })`.
- Intercept every outgoing API call with a transformer: `bot.api.config.use(async (prev, method, payload) => { calls.push({ method, payload }); return { ok: true, result: fakeResultFor(method, payload) }; })`.
- Feed fake updates straight in: `await bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 0, chat: { id: 42, type: 'private' }, from: { id: 42, is_bot: false, first_name: 'Maria' }, text: '/start GARCIA1', entities: [{ type: 'bot_command', offset: 0, length: 6 }] } })`.
- To make this possible, refactor `telegram.js` so the handlers are registered by an exported `buildBot(token, opts)` that returns the bot without starting it. `start()` then calls `buildBot(...).start()`.
- Use a temp `HEARTBRIDGE_DB` and `LLM_PROVIDER=none` (copy the header of `backend/test/contracts.test.js`).

---

## Tasks (in order; tick each box when it's pushed)

- [x] **K1. Testable bot + Telegram polish**
  - `buildBot()` refactor (above), plus a `test/channels.telegram.test.js` harness.
  - After a button tap: `answerCallbackQuery`, then edit the original message to remove the keyboard and append "→ <label>" so it can't be double-tapped.
  - `/start CODE` welcome in the patient's language. The i18n keys already exist in `core/i18n.js` (en + es): `welcome_patient`, `welcome_caregiver`, `unknown_code`, `help`, `language_prompt`, `language_set`, `voice_on/off`, `voice_unavailable`, `heard`, `file_too_large`. Use `t(patient.language, key, vars)` and `localize()` for non-native languages. Need more keys? Ask via REQUESTS.md.
  - Commands: `/checkin` (calls `startCheckin`), `/help` (short explainer), `/language` (inline picker built from `languages()`, `lang:<code>` → `store.updatePatient(id,{language})` → confirm in the new language), `/voice` (toggle `voiceMode`), `/meds` (list `patient.meds`).
  - Register the command list with `bot.api.setMyCommands` at start.
  - `reply.urgent` → send with `parse_mode: 'HTML'`, bold, 🚨 prefix. Escape HTML in user-provided text.
  - Caregiver chats: route text and button taps to `handleInbound({ role: 'caregiver', patientId, channel: 'telegram' })`.
  - Log group chat ids (`ctx.chat.type !== 'private'`) once, to help people find `NURSE_CHAT_ID`.
  - **Accept:** tests for /start valid + invalid code, patient and caregiver linking, text round-trip, button tap edits the message, every command, language switch changes the next check-in's language, urgent formatting, HTML escaping. `npm run check` green.

- [x] **K2. Judge mode (the #1 demo moment)**
  - `/start DEMO` and `/start DEMO_<LANG>` (e.g. `DEMO_ES`, `DEMO_VI`) → `enrollDemoPatient({ chatId, language })` → welcome → immediately send the `startCheckin` replies. A chat that's already linked and sends `/start DEMO` gets a fresh demo patient (clear the old link).
  - `/demo` (in the nurse group only) replies with the join links from `GET /api/join` logic.
  - Keep `routes/join.js` correct (it already returns deep links). Add `?format=text` returning plain links for printing.
  - **Accept:** a test where a fake judge chat runs the whole check-in via button taps and free text and a YELLOW alert lands in `store.listAlerts()`. Link tests for every language code in `languages()`.

- [x] **K3. Voice-first mode**
  - `integrations/speech.js`:
    - `transcribe(buffer, mime, languageHint)` uses the Groq Whisper API (`GROQ_API_KEY`, model `whisper-large-v3`, multipart upload; see TELEGRAM_SETUP §6). Returns `null` with no key or on error.
    - `tts(text, language)` uses `google-tts-api` (`getAllAudioUrls` for text longer than 200 chars). Returns `null` on failure.
  - In `telegram.js`: `message:voice` → `ctx.getFile()` → download → `transcribe` → `handleInbound({ voiceTranscript })`. If the transcript is `null`, reply asking the patient to type (in their language). When `reply.voice` is set, send the text **and** `replyWithVoice`/`replyWithAudio`.
  - Show a "🎙️ heard: …" line so the patient can see what was understood.
  - **Accept:** unit tests with mocked `fetch` for both Groq success and failure and for TTS URL building, plus a bot test where a voice update produces a check-in answer. The no-key path is tested.

- [x] **K4. Photos**
  - `message:photo` → take the largest `photo` size → download → base64 → `handleInbound({ photo: { base64, mime: 'image/jpeg' } })`. Also handle `message:document` images.
  - Reject files over 8 MB with a friendly message.
  - The core replies with a placeholder until P3-13 (med-bottle reconciliation) lands, and nothing needs to change on your side when it does.
  - **Accept:** a bot test with a mocked file download asserts `handleInbound` got base64 + mime, and the oversize path is covered.

- [x] **K5. SMS + WhatsApp adapters (channel-agnostic, the HIPAA-path story)**
  - Adapter registry in `channels/index.js`: `{ telegram, sms, whatsapp }`, each `{ name, isEnabled(), send(address, reply) }`. Route by `patient.channel` (default `telegram`) and fall back to any enabled channel the patient has an address for. **Keep the exported `sendToPatient/sendToCaregiver/sendToNurses` signatures exactly as they are.**
  - Buttons over SMS become numbered options ("Reply 1 for Normal, 2 for…"). Keep a per-patient map so an inbound "2" becomes that button's `data`.
  - `channels/twilio.js`: sends through the Twilio REST API with `fetch` (no SDK needed). Env: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`, `TWILIO_WHATSAPP_FROM` (sandbox `whatsapp:+14155238886`).
  - `routes/webhooks.js`: `POST /webhooks/twilio/sms` and `/whatsapp` (form-encoded `From`, `Body`). `JOIN <CODE>` links a phone (`store.updatePatient(id, { phone, channel })`). Otherwise route to `handleInbound`, reply via the REST API, and respond with empty TwiML. Validate the `X-Twilio-Signature` when the auth token is set.
  - **Accept:** tests for numbered-option mapping, JOIN linking, inbound → reply, signature validation on and off, adapter fallback, and a disabled channel doesn't throw. Document the Twilio trial/sandbox setup in `docs/TELEGRAM_SETUP.md` (a new "SMS & WhatsApp" section).

- [ ] **K6. Virtual devices**
  - `tools/virtual-scale.js` and `tools/virtual-oximeter.js`: CLI scripts that post to `POST /api/devices/readings`. For example `node tools/virtual-scale.js --patient p1 --lb 177.4`, or `--trend +0.8/day --days 5` which advances the demo clock between posts (`POST /api/demo/advance`).
  - `integrations/devices.js`: a small helper both CLIs share (validation, retries) and a stub for Withings OAuth (stretch goal, documented only).
  - **Accept:** tests for argument parsing and the request payloads (mock `fetch`). A manual check posts to a running backend, and the reading appears in `GET /api/patients/p1`.

- [ ] **K7. Hardening pass**
  - Rate-limit per chat (e.g. 20 msgs/min) and handle Telegram 429 retry-after.
  - Retry transient send failures once.
  - Handle the `409 Conflict` from a second poller with a clear log line.
  - Add a `/status` command in the nurse group (bot uptime, LLM provider from `llm.status()`, linked patient count).
  - **Accept:** tests for the rate limiter and retry logic, a manual run of the whole demo on your phone, and a list of anything flaky in REQUESTS.md.

## Definition of done (every task)
Tests written and green, `npm run check` green, a manual check noted in the commit body, box ticked here, then commit `[channels] …` and push.
