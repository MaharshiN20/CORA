# 💙 HeartBridge: heart-failure post-discharge co-pilot

A Telegram agent that checks in daily with heart-failure patients after they leave the hospital. It watches for red-flag symptoms, nudges medication and refill adherence, and escalates in tiers (self-care → nurse → 911), with caregivers kept in the loop.

**Why it matters:** about 1 in 5 Medicare discharges is readmitted within 30 days. CMS penalizes hospitals up to **3% of all Medicare reimbursement** for excess readmissions, and heart failure is one of the penalized conditions. That makes it a line item a hospital CFO cares about.

**Design principle:** Claude handles *language*, deterministic rules make *clinical decisions*. Triage never depends on an LLM.

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

## Who owns what

| Area | Owner | Files |
|---|---|---|
| Telegram connection | Telegram teammate | `backend/src/channels/telegram.js`, see [docs/TELEGRAM_SETUP.md](docs/TELEGRAM_SETUP.md) |
| Core logic (check-in, triage, risk, meds, pharmacy, caregiver) | Backend | `backend/src/core/*` |
| Dashboard | Backend | `frontend/src/*` |

The contract between them is `handleInbound()` / `sendToChat()`, documented at the top of `backend/src/core/agent.js`.

## Features (MVP)

- Risk-stratified daily check-ins (weight, breathing, swelling, chest pain, diuretic, SpO2)
- Weight-trend red flags (≥2 lb/day, ≥5 lb/week), the #1 early sign of CHF decompensation
- Tiered triage: 🟢 self-care tips · 🟡 nurse callback · 🔴 call 911 + immediate alerts
- Medication reminders + adherence tracking
- Pharmacy refill detection (unfilled prescriptions → nudge)
- Caregiver instant alerts + weekly digest
- Multilingual (en/es offline, more languages via Claude)
- Voice notes (Telegram voice → Whisper) *(stretch)*
- Wearable pulse-ox input *(stretch)*
