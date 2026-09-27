# Lane P: Prannav's Claude, core engine (critical path)

**You own:** `backend/src/core/**` (except `risk.js`), `backend/src/conditions/**`, `backend/src/store.js`, `backend/src/seed.js`, `backend/src/app.js`, `backend/src/routes/api.js`, `backend/src/routes/demo.js`, `backend/tools/e2e-*`, and docs outside `docs/team/KRISH.md` and `MAHARSHI.md`.
**Read first:** `CLAUDE.md`, `docs/STRATEGY.md`, `docs/CONTRACTS.md`. **At the start of every task:** check `docs/team/REQUESTS.md` for items addressed to @prannav, and skim the other lanes' recent commits (`git log --oneline -15`).

**Mission:** close the care loop so the product does what the strategy promises. Patients keep answering (outreach ladder, caregiver proxy, companion, their language), nurses see only what matters (worklist with reasons), and every decision is explainable (audit).

---

## Step 0: Team kit ✅
- [x] CLAUDE.md, CONTRACTS.md, lane files, REQUESTS.md, root scripts
- [x] clock, store collections (alert lifecycle, tasks, audit, readings, collection()), enroll, signals, agent contract (role/photo/urgent/voice), per-lane routers, device readings endpoint, contract tests

## P1: Care loop
- [x] **P1-1 Clock everywhere**: replace every remaining `new Date()`/`Date.now()` in core (checkin.finish, triage callers, escalation) with `clock`. Test: advancing the clock 1 day then checking in records the weight on the new day and the 24h delta uses the previous one.
- [x] **P1-2 Scheduler** `core/scheduler.js`:
  - A persisted `jobs` collection `{ id, kind, patientId, dueAt, status, payload }`, a 30s interval tick, and an instant tick on `clockEvents 'advance'`.
  - `scheduleForPatient(p)` builds jobs from the risk plan (check-in times, med times).
  - `POST /api/demo/tick`, and start the scheduler from `index.js`.
  - Idempotent: never double-send.
  - **Test:** advance 24h → exactly one check-in job per patient fires; a restart doesn't duplicate jobs.
- [x] **P1-3 Medications** `core/meds.js`: reminders with `med:<doseId>:taken|missed` buttons, dose records, adherence per med and overall (feeds `signals.adherence7d`), a missed diuretic feeds triage. i18n en/es. **Test:** full reminder → tap → adherence, and two missed diuretic days → YELLOW on the next check-in.
- [x] **P1-4 Pharmacy refill gaps** `core/pharmacy.js`:
  - A `refill_check` job flags any prescription unfilled 48h past `expectedPickup` → nudge with `rx:<med>:picked|ride|cost|other` buttons.
  - `barrier` is stored on the prescription.
  - `ride`/`cost` → `addTask` kind `refill` plus a resource message (pharmacy delivery, assistance programs); `picked` → `pickedUpAt`.
  - `POST /api/patients/:id/prescriptions/:med/picked-up` for the dashboard.
  - **Test:** Maria's furosemide gets a nudge after advance, a cost barrier creates a task, and picked stops the nudges.
- [x] **P1-5 Outreach ladder** `core/outreach.js`:
  - No reply to a check-in: +2h reminder, +6h caregiver ping with a "check in for her" button (`cmd:proxy`), +24h `addTask` kind `unreachable` (tier YELLOW).
  - Any reply cancels the ladder, and every step is audited (`outreach`).
  - **Test:** each rung fires at the right time via clock advance, and a reply mid-ladder cancels the rest.
- [x] **P1-6 Nurse workflow**:
  - `POST /api/patients/:id/message { text, from }` → the patient via channels, logged `from: nurse`.
  - A "call scheduled" template, and alert-ack notifications to the patient ("Nurse Kim saw your update and will call you").
  - Wire M1 `recordRisk` after each check-in once it exists (see REQUESTS).
  - **Test:** the message is delivered and logged, and ack triggers the patient notice.
- [x] **P1-7 Caregiver loop**:
  - Proxy check-in: `role: 'caregiver'` + `cmd:proxy` runs the check-in flow on the patient's record, with answers tagged `reporter: 'caregiver'` and replies to the caregiver in their language.
  - `caregiverConsent` gate.
  - `core/digest.js` weekly digest (weight trend, adherence, alerts, refills) via a `digest_weekly` job and `POST /api/patients/:id/digest`.
  - **Test:** a caregiver completes a check-in → an alert with `reporter: caregiver`; the digest content snapshot.
- [x] **P1-9 Wire the risk-LLM reviewer + risk history** (also call Maharshi's `recordRisk(patient)` after each check-in once M1 lands; moved here from P1-6) (Maharshi's `riskllm/reviewPatient`): after each check-in `finish`, run it **asynchronously**, so the patient reply is never delayed. Pass the rules result + recent English messages. If `escalate`, add a YELLOW alert (`source: 'ai_review'`, reasons = concerns with evidence, `nurseSummary`) and audit `ai_review` either way. A `null` result means rules stand silently. **Test:** mocked reviewer escalate → alert; null → no alert; RED from rules is never touched.
- [x] **P1-8 E2E harness** `backend/tools/e2e-demo.js` (`npm run e2e`): boots the app on a temp DB and drives the Maria story over HTTP (check-in → YELLOW → worklist → ack → message), asserting each step. It grows with every later feature.

## P2: Intelligence & equity
- [x] **P2-8 Discharge companion** `core/companion.js` (content lives in `conditions/chf/content.js`, bilingual JS rather than markdown, so the offline fallback works in Spanish):
  - Seed discharge instructions per patient plus `conditions/chf/education.md`.
  - Order: safety gate (red flags → triage) → LLM intent classification → an answer **only** from those sources, with a citation → otherwise "I'll ask your nurse" + `addTask` kind `question`.
  - Keyword-FAQ fallback without an LLM.
  - Guardrail tests: it refuses dosing changes, emergencies go to triage, and out-of-scope questions go to the nurse.
- [ ] **P2-9 Teach-back lessons** `core/lessons.js`: 8–10 micro-lessons (daily weights, salt, fluid, when to call, meds) with `lesson:<id>:<choice>` quiz buttons, a `lesson_due` job, and `patient.lessons.score`. Test: scoring and no repeats.
- [ ] **P2-10 SDOH screen** `core/sdoh.js`: a day-2 `sdoh_screen` job asks about a ride to follow-up, medication cost, food access and help at home using `sdoh:*` buttons → `patient.sdoh.flags` + resources (211, pharmacy assistance) + `addTask` kind `sdoh`. Test: the flags → tasks mapping.
- [ ] **P2-11 Language quality**: a generated template cache `i18n/generated/<lang>.json` (built via the LLM, marked `needsReview`), `localize()` checks the cache first, and a `npm run i18n:build` script. Test: the cache hit avoids an LLM call.

## P3: Platform
- [ ] **P3-12 Condition packs**: move CHF steps, prompts, rules and advice to `conditions/chf/`. Keep `core/triage.js` as a re-export so the existing tests pass unchanged. Add `conditions/copd/` (SpO2, inhaler use, sputum colour, breathlessness scale) with its own triage tests, and `patient.condition` selects the pack.
- [ ] **P3-13 Med-bottle photo reconciliation**:
  - Add `llm.completeVision` (Claude image blocks; Ollama/LM Studio OpenAI-style `image_url` data URIs; prefer VL models).
  - Extract `{ drug, strength, directions }`, compare against `patient.meds`, and flag a mismatch or unknown drug → `addTask` kind `med_discrepancy`.
  - Without a vision model, ask the patient to type the label.
  - Tests with a mocked vision response.
- [ ] **P3-14 Device readings → triage**: run triage on `POST /api/devices/readings` (SpO2 < 90 RED, weight trend), merge device and self-reported weights, and the RPM day count in signals. Test: a device SpO2 of 88 → RED alert + caregiver.

## P4: Demo readiness
- [ ] **P4-15 Scenarios** `core/scenarios/`: `maria` (5-day decompensation), `johnson` (refill barrier), `nguyen` (silent → ladder → caregiver proxy), `judge` (fresh demo patient). `GET /api/demo/scenarios` + `POST /api/demo/scenario/:name`, deterministic.
- [ ] **P4-16 E2E for every scenario** (extend P1-8), running both with no LLM and with a local LLM.
- [ ] **P4-17 Docs**: `docs/DEMO_SCRIPT.md` (3-minute pitch + click path + fallback plan), `docs/SAFETY_PRIVACY.md`, `docs/ARCHITECTURE.md` (with a diagram).
- [ ] **Integration 1** (after P1 + K1–K2 + M3 Worklist/Patient) and **Integration 2** (everything): full live run, fix gaps, update CONTRACTS.md.

## Definition of done (every task)
Tests written and green, `npm run check` green, a manual check noted in the commit body, box ticked here, then commit `[core] …` and push.
