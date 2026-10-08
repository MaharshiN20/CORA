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

- [x] **K6. Virtual devices**
  - `tools/virtual-scale.js` and `tools/virtual-oximeter.js`: CLI scripts that post to `POST /api/devices/readings`. For example `node tools/virtual-scale.js --patient p1 --lb 177.4`, or `--trend +0.8/day --days 5` which advances the demo clock between posts (`POST /api/demo/advance`).
  - `integrations/devices.js`: a small helper both CLIs share (validation, retries) and a stub for Withings OAuth (stretch goal, documented only).
  - **Accept:** tests for argument parsing and the request payloads (mock `fetch`). A manual check posts to a running backend, and the reading appears in `GET /api/patients/p1`.

- [ ] **K7. Hardening pass**
  - Rate-limit per chat (e.g. 20 msgs/min) and handle Telegram 429 retry-after.
  - Retry transient send failures once.
  - Handle the `409 Conflict` from a second poller with a clear log line.
  - Add a `/status` command in the nurse group (bot uptime, LLM provider from `llm.status()`, linked patient count).
  - **Accept:** tests for the rate limiter and retry logic, a manual run of the whole demo on your phone, and a list of anything flaky in REQUESTS.md.

## Handed over from Prannav's Oct 8 audit pass (K8 to K16)

**Context:** Prannav's Claude did a full audit and fixed most of it (27 commits, see the log and the Oct 8 entry in `docs/team/REQUESTS.md`; contract changes are in `docs/CONTRACTS.md`). These items were left out. Read `CONTRACTS.md` first: the outbox (`channels/index.js`), `security.js`, and `core/devicetriage.js` are new and you will build on them.
**Permission:** Prannav approved editing files outside your lane for these tasks (same arrangement as the Oct 8 pass). Keep each change small, one feature per commit, and note the cross-lane files in the commit body. Same loop as always: tests that never touch the network, `npm run check` green, then push.

- [x] **K8. Telegram webhook mode (production path)**
  - Long polling stays the default. With `TELEGRAM_WEBHOOK_URL` (+ `TELEGRAM_WEBHOOK_SECRET`) set, call `setWebhook` with `secret_token`, mount `POST /webhooks/telegram`, and reject any request whose `X-Telegram-Bot-Api-Secret-Token` doesn't match (constant-time compare, see `security.js` `safeEqual`). Dedupe on `update_id` (short TTL). Fail closed in production if the URL is set but the secret is not.
  - Stop polling when webhook mode is on; `stop()` should delete the webhook only when asked.
  - **Accept:** tests with `bot.handleUpdate` for a valid secret, a wrong/missing secret (403), a replayed `update_id`, and the polling default unchanged. Document it in `docs/TELEGRAM_SETUP.md`.

- [x] **K9. `/api/ready` + startup config check**
  - `GET /api/ready` (public like `/health`, but no secrets in it): `{ ready, checks: { store, scheduler, telegram, twilio, llm, nurseChannel, outbox: { pending, dead } } }`, 503 when the store is unwritable. Count `outbox` rows by status.
  - A startup validator in `index.js` that logs one clear warning per misconfiguration: `API_TOKEN` unset, `NODE_ENV=production` without `CORS_ORIGIN`, `TWILIO_AUTH_TOKEN` set without `PUBLIC_URL`, no nurse channel (`NURSE_CHAT_ID` / `NURSE_PHONE`), default public `FHIR_BASE_URL` in production. Pure function `configWarnings(env)` so it is unit-testable.
  - **Accept:** tests for `configWarnings` (each case + a clean config returns `[]`) and for `/api/ready`.

- [x] **K10. Withings webhook signature (stub to real check)**
  - `integrations/devices.js` has a Withings stub with no verification. Add `verifyWithingsSignature(rawBody, headers, secret)` (HMAC-SHA256, constant-time) and a `POST /webhooks/withings` route that rejects unsigned requests when `WITHINGS_CLIENT_SECRET` is set (fail closed in production, like Twilio) and turns a measure into the same path as `POST /api/devices/readings` through `core/devicetriage.js` `triageReading`, with `readingId` from the Withings id so retries are idempotent.
  - **Accept:** tests with a fixture payload: valid signature, tampered body, duplicate delivery (one reading), out-of-range value rejected.

- [x] **K11. Index messages / audit / alerts by patient (`store.js`)**
  - `listMessages(id)`, `listAudit(id)`, alerts-by-patient are full-array filters on hot paths (every inbound, every `GET /patients/:id`). Add lazily-built `Map<patientId, items[]>` caches that are rebuilt when the underlying array is replaced or resized (the same pattern as the key index in `core/scheduler.js`), so `prune()` and `reset()` can never leave them stale. Keep every exported function's return shape and order.
  - **Accept:** the existing suite unchanged and green, plus tests that the index is correct after `reset`, `prune`, `resetPatient`, and direct pushes to `collection()`; a quick timing test with 20k audit rows.

- [x] **K12. Cancel in-flight AI reviews**
  - `riskllm` times out with `Promise.race`, but the provider request keeps running. Thread an `AbortSignal` through `core/llm/index.js` `run()` and the providers' `chat(opts)` (`opts.signal`), and have `riskllm/index.js` and `core/aireview.js` abort on timeout. Keep `deadlineMs` behaviour for patient-facing calls.
  - **Accept:** a test with a fake provider that records `signal.aborted` after the timeout; existing `llm.test.js`, `riskllm*.test.js` and `aireview*.test.js` unchanged and green.

- [x] **K13. Eval set for the AI risk reviewer**
  - `evals/` only measures the language parser. Add `evals/risk-cases.jsonl` (about 40 labelled trajectories: weight creep, recliner, missed refills, stable controls, plus injection attempts) and a scorer that reports escalation precision/recall and checks the invariants that must always hold: never lowers a tier, never returns RED, unknown tiers never escalate. A deterministic `call` stub drives it offline in `npm test`; `npm run eval -- --risk` runs it against real providers.
  - **Accept:** an offline test that enforces the invariants on the whole case file; README section.

- [x] **K14. Bulk alert actions**
  - Dashboard: checkboxes on cards and "Acknowledge selected" / "Assign selected to me" (INFO and YELLOW only; RED is never bulk-actioned). Backend: `PATCH /api/alerts` with `{ ids, status?, assignee?, by }`, max 50 ids, same validation and audit rows (`nurse_action`) as the single-alert PATCH, patient ack notices sent once per alert. Partial failures reported per id.
  - **Accept:** backend tests (RED refused, unknown id reported, audit rows written) and Vitest for selection + the request body.

- [x] **K15. Non-English safety net without an LLM**
  - Rules catch free-text emergencies in Vietnamese, Hindi and Chinese in only about 1 of 6 messages (`backend/test/evals.gate.test.js` pins it). Add hand-written red-flag patterns for those three languages in `core/parser.js` (chest pain, can't breathe, fainted, confused; negation-aware, with a native speaker or reviewer note for each list), and raise the floors in `evals.gate.test.js` as recall improves. Where no LLM is available, append the "call 911 if you have chest pain or can't breathe" line to every outbound check-in prompt for those languages (new i18n key, en + es + generated templates).
  - **Accept:** new rows in `evals/messages.jsonl` (keep the validator green), the gate test floors raised, zero false alarms on the calm rows.

- [ ] **K16. Refuse the public FHIR sandbox in production**
  - `integrations/fhir.js` defaults to the public HAPI server. When `NODE_ENV=production` and `FHIR_BASE_URL` is unset, refuse to import (clear 503 `{ error }`) instead of sending patient identifiers to a public sandbox; `GET /api/fhir` reports `{ base, sandbox: true }`. Dashboard import dialog shows a banner when `sandbox` is true.
  - **Accept:** tests for production-unset (refused), production-set (works), development (works, flagged sandbox).

## Definition of done (every task)
Tests written and green, `npm run check` green, a manual check noted in the commit body, box ticked here, then commit `[channels] …` and push.
