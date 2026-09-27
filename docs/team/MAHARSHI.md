# Lane M: Maharshi's Claude, risk, insights & dashboard

**You own:** `backend/src/core/risk.js`, `backend/src/riskllm/**` (your risk-LLM reviewer, already merged), `backend/src/insights/**`, `backend/src/routes/insights.js`, `backend/src/routes/fhir.js`, `backend/src/integrations/fhir.js`, `frontend/**`, `evals/**`, and tests named `backend/test/risk*.test.js`, `insights*.test.js`, `fhir*.test.js`.
**Read first:** `CLAUDE.md` (team rules + the per-task loop), `docs/STRATEGY.md`, `docs/CONTRACTS.md` (all of it: you consume every API), and the current `frontend/src/App.jsx`, `backend/src/core/risk.js`, `backend/src/core/signals.js`.

**Mission:** turn the data into the thing judges *see*: a nurse command center that shows the system making good calls, a patient view that explains every decision, and an impact page that proves it's worth adopting. Plus a dynamic risk model and evidence (evals) that the parsing is reliable.

**Rules for your lane:**
- `scoreRisk(patient)` must keep its contract (`docs/CONTRACTS.md` §2). The core relies on `tier` and on the `plan` keys.
- Insights read data through the store API only. Synthetic cohort data goes in `store.collection('cohort')` and **must never mix with the live demo patients**.
- The dashboard must keep working on the current API while Prannav's lane adds fields. Treat anything marked "coming" in CONTRACTS.md as optional (`?.`, empty states).
- Frontend testing: add `vitest` + `@testing-library/react` for component logic (sorting, SLA countdowns, ROI math) and keep `npm run build` green. Backend: `node:test` like everyone else.

---

## Tasks (in order; tick each box when it's pushed)

- [x] **M0. Put `riskllm` on the shared rails** (small, do first)
  - Route model calls through the shared chain (`core/llm/index.js`: `completeJSON`, which tries Claude → Ollama → LM Studio) instead of calling Ollama's `/api/chat` directly, so the reviewer also works with LM Studio or Claude. Keep your injectable `call` for tests. If you need JSON-schema-constrained output, request a `completeJSON(system, user, { schema })` option from @prannav in REQUESTS.md rather than bypassing the chain.
  - Use `core/clock.js` `now()` as the default for `now`, so demo clock advances affect weight slopes.
  - Keep `RISK_LLM=off` working. Update `backend/.env.example` (your section) with `RISK_LLM`, `RISK_MODEL`, `RISK_TIMEOUT_MS`.
  - Prannav's lane wires `reviewPatient()` into check-in completion (P1-9) and turns `escalate: true` into a YELLOW alert with `source: 'ai_review'` and your `concerns` as reasons. Your returned shape is the contract for that; it's documented in CONTRACTS.md §2.
  - **Accept:** your existing riskllm/lexicon tests stay green, plus new tests showing it runs through a mocked chain and returns `null` when no provider is available.

- [x] **M1. Risk v2: static + dynamic, explainable**
  - Keep the current additive baseline (rename its factors' section to "baseline").
  - Add a dynamic component from `getSignals(patient)`: missed check-ins, adherence under 80%, weight trend, open RED/YELLOW alerts, SDOH flags, low lesson score. Each gives points with a human label ("Missed 2 check-ins this week +2").
  - Tier comes from baseline + dynamic. `plan` is still derived from tier. Return `dynamic: { score, factors, trend }`.
  - Keep a risk history: `store.collection('riskHistory')` rows `{ ts, patientId, score, tier }` written by an exported `recordRisk(patient)`. The core will call it after each check-in, so file a REQUESTS.md item for Prannav to wire it.
  - **Accept:** `scoreRisk(p)` without signals behaves exactly as before (the existing seed/check-in tests stay green). New tests for each dynamic factor, tier boundaries, trend, and missing signals (null) adding 0 points.

- [ ] **M2. Insights API: prove the impact** (`backend/src/insights/*.js`, `routes/insights.js`)
  - `insights/cohort.js`: a deterministic (seeded PRNG) generator of about 60 historical 30-day patient journeys. Include a language mix (en/es/vi/hi/zh), check-in engagement, alerts with outcomes, readmissions (baseline around 20%, lower when engaged), response times and refill gaps. It's stored in `store.collection('cohort')` and regenerated on demand with `POST /api/insights/cohort/regenerate`.
  - Endpoints, each combining cohort + live demo patients, with `?source=cohort|live|all`:
    - `GET /api/insights/impact`: readmission rate engaged vs not, projected readmissions avoided, alerts per nurse per day, median time-to-ack, alert precision (true_positive / resolved).
    - `GET /api/insights/engagement`: daily check-in response rate, drop-off curve by day since discharge (this is the metric that failed Tele-HF and BEAT-HF), and ladder recoveries (patients who came back after a nudge or caregiver ping).
    - `GET /api/insights/equity`: the same metrics broken down by language, showing non-English patients are served as well as English ones.
    - `GET /api/insights/roi?discharges=&readmitRate=&costPerReadmit=&reduction=&penaltyPct=&medicareRevenue=`: HRRP penalty avoided, readmission costs avoided, TCM billable (contact within 2 business days, $220/$298), RPM-eligible (≥16 reading-days, ~$52/mo + $52/20 min). Defaults and sources come from `docs/STRATEGY.md`.
  - **Accept:** tests for each metric on a small hand-built dataset (exact numbers), a determinism test for the generator, and ROI math tests. `curl` each endpoint.

- [ ] **M3. Dashboard overhaul: the nurse command center** (`frontend/`)
  - Stack: React Router, Tailwind v4 (`@tailwindcss/vite`), recharts, `qrcode`, socket.io live refresh (already wired in `src/api.js`). Clean clinical design, big readable type, and a "projector mode" toggle that scales everything up.
  - **Worklist** `/`:
    - All open alerts and tasks, sorted by tier → SLA (`dueBy`) → risk, with live SLA countdowns (red when overdue).
    - Kind badges (triage/unreachable/refill/sdoh/question/med_discrepancy/device).
    - One-click Acknowledge → Contacted → Resolve with an outcome picker (`PATCH /api/alerts/:id`).
    - "Message patient" box (uses `POST /api/patients/:id/message` once P1-6 lands; hide it until the endpoint exists).
    - A filter by kind/tier, and a patient list side panel with risk + last tier.
  - **Patient** `/patients/:id`:
    - Header (risk tier with baseline + dynamic factors, language, caregiver, days since discharge).
    - Weight chart with the dry-weight / +2 / +5 lb reference lines, check-in timeline (tier chips, answers), adherence heatmap from `doses`.
    - Prescriptions with pickup status and `barrier`, SDOH flags, lessons score (all "coming": show an empty state).
    - **"Why" panel** from `audit` + alert `reasons` (the explainability selling point).
    - Conversation log with English translations and tappable buttons (keep today's simulator behaviour).
  - **Impact** `/impact`: M2 charts (engaged vs not readmission, drop-off curve, equity by language, time-to-ack) plus an interactive ROI calculator.
  - **Demo console** `/demo`:
    - QR codes for each language from `GET /api/join`, clock controls (`/api/demo/clock`, `advance` +6h/+1d/+3d, `reset`), and scenario buttons from `GET /api/demo/scenarios` (render whatever it returns).
    - An embedded **phone simulator** that picks a patient and chats through `/api/patients/:id/simulate` with buttons, as patient or caregiver (`role`).
    - A health strip (API, Telegram, LLM provider).
  - **Join** `/join`: a full-screen QR grid for judges ("Scan to become a patient").
  - **Accept:** `npm run build` green, vitest tests for sorting, SLA countdown, outcome flow and ROI math, and a manual walkthrough of all pages against a running backend with Maria's story (run her check-in from the simulator, then watch the alert appear live on the Worklist). Screenshots go in the PR/commit body if possible.

- [ ] **M4. Evals: evidence the language layer is reliable** (`evals/`)
  - `evals/messages.jsonl`: at least 150 labelled messages `{ id, lang, step, text, expected: { weightLb?, breath?, orthopnea?, swelling?, chestPain?, dizzy?, confusion?, fainting?, diureticTaken?, spo2? } }`.
    - Mix en/es/vi/hi/zh.
    - Include hard cases: negations ("no chest pain", "sin dolor de pecho"), units (kg), typos, run-on messages, sarcasm/noise, and emergencies hidden in chit-chat.
  - `evals/run.js` (`npm run eval` in backend, add the script): runs the rules parser (`parseFreeText`, `parseWeight`, `detectRedFlags` from `core/parser.js`) and each available LLM provider (`parseWithLLM` with `LLM_PROVIDER` pinned per run). It writes `evals/RESULTS.md`: per-field precision/recall per provider and language, red-flag recall, latency p50/p95.
  - **Gate:** rules red-flag recall on en/es must be 100%. Any miss becomes a REQUESTS.md item for Prannav with the failing examples, since the parser is core-owned.
  - **Accept:** `npm run eval` works with no LLM (rules only) and with LM Studio/Ollama when running. RESULTS.md is committed.

- [ ] **M5. FHIR import: "enroll straight from the EHR"**
  - `integrations/fhir.js`: fetch from the public HAPI R4 sandbox (`https://hapi.fhir.org/baseR4`, configurable `FHIR_BASE_URL`). Map `Patient` (name, birthDate → age, communication.language → language), `MedicationRequest` (→ meds + prescriptions) and `Condition` (flags such as CKD/diabetes/COPD in `profile`), then `createPatient({ ..., source: 'fhir' })`.
  - `routes/fhir.js`: `GET /api/fhir/search?name=` and `POST /api/fhir/import { fhirPatientId }`.
  - Dashboard: an "Import from EHR" dialog on the Worklist patient panel.
  - **Accept:** tests with recorded FHIR JSON fixtures (no network), covering the mapping edge cases (missing birthDate, unknown language, no meds). A manual import from the live sandbox works.

## Definition of done (every task)
Tests written and green, `npm run check` green, a manual check noted in the commit body, box ticked here, then commit `[insights]`/`[ui]`/`[evals]` and push.
