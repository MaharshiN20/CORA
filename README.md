# 💙 HeartBridge: heart-failure post-discharge co-pilot

A Telegram agent that checks in daily with heart-failure patients after they leave the hospital. It watches for red-flag symptoms, nudges medication and refill adherence, and escalates in tiers (self-care → nurse → 911), with caregivers kept in the loop.

**Why it matters:** about 1 in 5 Medicare discharges is readmitted within 30 days. CMS penalizes hospitals up to **3% of all Medicare reimbursement** for excess readmissions, and heart failure is one of the penalized conditions. That makes it a line item a hospital CFO cares about.

**Design principle:** the LLM handles *language*, deterministic rules make *clinical decisions*. Triage never depends on an LLM.

📌 **Start with [docs/STRATEGY.md](docs/STRATEGY.md)**: problem analysis, thesis, demo plan, roadmap, ownership.

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
# terminal 1
cd backend && cp .env.example .env && npm install && npm run dev     # :3001
# terminal 2
cd frontend && npm install && npm run dev                            # :5173
```

No keys needed to start. Without a Telegram token you can still chat as a patient from the dashboard's "Simulate a patient reply" box.

### AI (optional, auto-detected)
The backend picks the first available provider: **Claude → Ollama → LM Studio → rules only**. The dashboard shows which one is in use.
- **Claude**: set `ANTHROPIC_API_KEY` in `backend/.env`.
- **Ollama**: `ollama pull qwen2.5:7b-instruct` and leave Ollama running.
- **LM Studio**: load a model, then Developer → Start Server (or `lms server start && lms load qwen/qwen3-4b`).
- Pin one with `LLM_PROVIDER=claude|ollama|lmstudio|none`. New providers are picked up within 60s without a restart.
- Multilingual instruct models work best (Qwen 2.5/3, Llama 3.x). Tiny models (≤4B) translate noticeably worse; use 7–9B+ for demos.

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
