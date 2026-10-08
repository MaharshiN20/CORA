# 💙 HeartBridge: heart-failure post-discharge co-pilot

A Telegram agent that checks in daily with heart-failure patients after they leave the hospital. It watches for red-flag symptoms, nudges medication and refill adherence, and escalates in tiers (self-care → nurse → 911), with caregivers kept in the loop.

**Why it matters:** about 1 in 5 Medicare discharges is readmitted within 30 days. CMS penalizes hospitals up to **3% of all Medicare reimbursement** for excess readmissions, and heart failure is one of the penalized conditions. That makes it a line item a hospital CFO cares about.

**Design principle:** the LLM handles *language*, deterministic rules make *clinical decisions*. Triage never depends on an LLM.

📌 **Start with [docs/STRATEGY.md](docs/STRATEGY.md)** (why), **[docs/CONTRACTS.md](docs/CONTRACTS.md)** (interfaces), and **[CLAUDE.md](CLAUDE.md)** (team workflow).
👥 Three lanes run in parallel, each with its own task file: [Prannav: core](docs/team/PRANNAV.md) · [Krish: channels](docs/team/KRISH.md) · [Maharshi: risk, insights, dashboard](docs/team/MAHARSHI.md). Cross-lane asks go in [REQUESTS.md](docs/team/REQUESTS.md).

## Layout

```
backend/    Node 22 + Express + grammY (Telegram) + socket.io
  src/core/       check-in engine, risk scoring, triage, meds, pharmacy, caregiver digest
  src/channels/   telegram.js (patient/caregiver UI), index.js (outbound routing)
  src/routes/     REST API for the dashboard + demo controls
frontend/   Vite + React nurse dashboard (patients, alerts, weight chart, conversation log)
docs/       TELEGRAM_SETUP.md: bot setup + task list for the Telegram owner
```

## Run it

```bash
cp backend/.env.example backend/.env   # optional: add tokens/keys
npm run setup                          # install root + backend + frontend
npm run dev                            # backend :3001 + dashboard :5173
npm run check                          # all tests + frontend build (run before every push)
npm run e2e                            # rehearse the whole demo story over HTTP (no Telegram/LLM needed)
```

No keys needed to start. Without a Telegram token you can still chat as a patient from the dashboard's "Simulate a patient reply" box.

### Before anyone else can reach it (security and operations)
Locally nothing is required. Before you expose the server to other people, set these in `backend/.env` (all documented in `.env.example`):
- `API_TOKEN`: the dashboard and the live feed then require it (the dashboard asks for it once). Unset = open, with a warning at startup.
- `CORS_ORIGIN`: the dashboard's origin. `NODE_ENV=production` also turns **off** the reset / clock-advance / cohort-regenerate controls unless `DEMO_MODE=1`.
- `DEVICE_KEY`: home devices send it as `x-device-key` to `POST /api/devices/readings` (that endpoint only).
- `TWILIO_AUTH_TOKEN` and `PUBLIC_URL`: required in production, or the SMS/WhatsApp webhooks refuse every request.
- `TELEGRAM_WEBHOOK_URL` + `TELEGRAM_WEBHOOK_SECRET` switch Telegram from long polling to a webhook ([setup §9](docs/TELEGRAM_SETUP.md)); `WITHINGS_CLIENT_SECRET` makes `POST /webhooks/withings` require a signed body. In production both webhooks refuse every request until their secret is set.
- `NURSE_CHAT_ID` (Telegram group) and optionally `NURSE_PHONE` (SMS fallback): where alerts go. A message that can't be delivered is queued and retried, and an alert whose nurse page could not go out shows a warning on its card.
- Care codes lock to the first chat/phone that uses them (`ALLOW_RELINK=0`, the production default); a nurse releases one with `POST /api/patients/:id/unlink`.
- Data lives in `backend/data/db.json` and is written atomically with a rolling `.bak`; a corrupt file is restored from it or the server refuses to start, never silently reset.
- `GET /api/audit.csv` exports the audit log. `.github/workflows/ci.yml` runs `npm run check` on every push.
- `GET /api/ready` is the probe for a load balancer or uptime monitor (public, no secrets in it): `503` when the store can't be written, plus the state of the scheduler, Telegram, Twilio, the LLM chain, the nurse channel and the outbox (`pending` / `dead` messages).
- At startup the backend prints one `[config]` line per setting that is probably a mistake: `API_TOKEN` unset, production without `CORS_ORIGIN`, `TWILIO_AUTH_TOKEN` without `PUBLIC_URL`, no (or an unusable) nurse channel, the public FHIR sandbox in production.

### AI (optional, auto-detected)
The backend picks the first available provider: **Claude → Gemini → Ollama → LM Studio → rules only**. The dashboard shows which one is in use.
- **Claude**: set `ANTHROPIC_API_KEY` in `backend/.env`.
- **Gemini**: set `GEMINI_API_KEY` in `backend/.env` (default model `gemini-flash-latest`; set `GEMINI_MODEL` to change it). Note that a system-wide `GEMINI_API_KEY` takes precedence over `.env`.
- **Ollama**: `ollama pull qwen2.5:7b-instruct` and leave Ollama running.
- **LM Studio**: load a model, then Developer → Start Server (or `lms server start && lms load qwen/qwen3-4b`).
- Pin one with `LLM_PROVIDER=claude|gemini|ollama|lmstudio|none`. New providers are picked up within 60s without a restart.
- Multilingual instruct models work best (Qwen 2.5/3, Llama 3.x). Tiny models (≤4B) translate noticeably worse; use 7–9B+ for demos.
- `npm --prefix backend run i18n:build -- --langs vi,hi` pre-translates every patient message template (placeholders validated) into `backend/src/core/i18n-generated/`. Those languages then work **offline** and consistently. The files are marked `needsReview` until a bilingual reviewer checks them.

## Who owns what

| Area | Owner | Files |
|---|---|---|
| Telegram connection | Telegram teammate | `backend/src/channels/telegram.js`, see [docs/TELEGRAM_SETUP.md](docs/TELEGRAM_SETUP.md) |
| Core logic (check-in, triage, meds, pharmacy, caregiver, LLM chain) | Backend | `backend/src/core/*` |
| Risk assessment | Risk teammate | `backend/src/core/risk.js`: keep the `scoreRisk(patient) → { score, tier, factors, plan }` contract |
| Dashboard | Backend | `frontend/src/*` |

The contract between them is `handleInbound()` / `sendToChat()`, documented at the top of `backend/src/core/agent.js`.

## Features (MVP)

- Risk-stratified daily check-ins (weight, breathing, swelling, chest pain, diuretic, SpO2)
- Weight-trend red flags (≥2 lb/day, ≥5 lb/week), the #1 early sign of CHF decompensation
- Tiered triage: 🟢 self-care tips · 🟡 nurse callback · 🔴 call 911 + immediate alerts
- Medication reminders + adherence tracking
- Pharmacy refill detection (unfilled prescriptions → nudge)
- Caregiver instant alerts + weekly digest
- Multilingual (en/es offline, any language via Claude / Ollama / LM Studio)
- Voice notes (Telegram voice → Whisper) *(stretch)*
- Wearable pulse-ox input *(stretch)*
