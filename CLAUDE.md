# HeartBridge: instructions for every Claude on this team

HeartBridge is a multilingual post-discharge co-pilot for heart-failure patients. It's a Telegram agent (SMS/WhatsApp later) that runs daily check-ins, watches for red flags, nudges medications and refills, keeps caregivers in the loop, and escalates in tiers to a nurse dashboard. Track: **Social Good (Healthcare)**.

**Read before any work:** `docs/STRATEGY.md` (why), `docs/CONTRACTS.md` (the interfaces you must not break), then your lane file.

## 1. Find your lane
Three people each run their own Claude on this repo in parallel. Each lane owns different files.

| Teammate | Lane file | Owns |
|---|---|---|
| **Prannav** | `docs/team/PRANNAV.md` | core engine: `backend/src/core/**` (except `risk.js`), `conditions/**`, `store.js`, `seed.js`, `routes/api.js`, `routes/demo.js` |
| **Krish** | `docs/team/KRISH.md` | channels: `backend/src/channels/**`, `integrations/speech.js`, `integrations/devices.js`, `routes/webhooks.js`, `routes/join.js`, `tools/virtual-*` |
| **Maharshi** | `docs/team/MAHARSHI.md` | risk + insights + dashboard: `core/risk.js`, `backend/src/riskllm/**`, `backend/src/insights/**`, `routes/insights.js`, `routes/fhir.js`, `integrations/fhir.js`, `frontend/**`, `evals/**` |

To work out who you're working for: go by what the user says ("I'm Krish", "start Maharshi's lane"), then `git config user.name`, and if still unclear, **ask**. When told "start your lane" / "continue", open your lane file and work through the unchecked tasks **in order, autonomously**. Don't wait for confirmation between tasks.

## 2. Non-negotiable product rules
- **The LLM handles language; rules decide.** Rules own every tier and all 911 logic. LLMs parse, translate and answer questions. **One sanctioned exception:** `backend/src/riskllm/` may *raise* GREEN → YELLOW (nurse review) with stated evidence. It never lowers a tier and never triggers RED/911 (`mergeTier`). Nothing else may let a model change a tier.
- **Degrade gracefully.** No LLM → rules. No Telegram → dashboard simulator. No device → self-report. No key should ever be required to run or test.
- **Time comes from `core/clock.js`** (`now()`, `nowISO()`), never `Date.now()` / `new Date()` in backend logic, so the demo clock can move time forward.
- **Patient-facing text goes through `core/i18n.js`** (`t(lang, key)`) with en + es entries. Never hardcode English strings to patients.
- **Data goes through the `store.js` API only.** Need your own data? Use `store.collection('<name>')` and don't edit `store.js`.

## 3. The loop for every task
1. `git pull --rebase` (resolve trivial conflicts. For anything non-trivial in another lane's files, stop and add a note to `docs/team/REQUESTS.md`).
2. Read the task's acceptance criteria in your lane file.
3. Implement in your own files. Match the surrounding style: ESM JavaScript, no TypeScript, comments that explain *why*, the same naming and density as nearby code.
4. **Test rigorously:**
   - Add `node:test` tests in `backend/test/` for backend work.
   - Tests must never hit the network or a real LLM. Mock `fetch`, set `process.env.LLM_PROVIDER='none'`, and use a temp `HEARTBRIDGE_DB` (copy the header of `backend/test/contracts.test.js`).
   - Cover the happy path, edge cases, and failure/fallback paths.
5. `npm run check` from the repo root (all backend tests + frontend build) must be **green**. Fix what you broke. If a failure is in another lane's code and not caused by you, log it in `REQUESTS.md` and don't edit their files.
6. Manually verify the feature (curl the API, click the dashboard, or message the bot) and note what you checked in the commit body.
7. Tick the task's checkbox in **your own** lane file.
8. Commit **one feature per commit** with a prefix: `[core] …`, `[channels] …`, `[insights] …`, `[ui] …`, `[evals] …`, `[docs] …`.
9. `git pull --rebase && npm run check && git push`. Never `--force`, never `--no-verify`.

## 4. Shared files (additive edits only, keep them tiny)
- `backend/src/app.js`: add ONE import + ONE `app.use` line per new router.
- `backend/package.json`, `frontend/package.json`, root `package.json`: add dependencies with `npm install <pkg>` inside the right folder.
- `backend/.env.example`: append to your own section only.
- `docs/team/REQUESTS.md`: append-only.
- Need a contract change, or something from another lane? Append to `docs/team/REQUESTS.md` as `- [ ] @owner from @you: what + why`, then keep working on your next unblocked task. The owner ticks it when done.

## 5. Running things
```bash
npm run setup      # install root + backend + frontend
npm run dev        # backend :3001 + dashboard :5173
npm test           # backend tests
npm run check      # tests + frontend build (run before every push)
npm run e2e        # full demo story over HTTP with a readable step log (also runs inside npm test)
npm run seed       # reset demo data
```
Optional AI: the chain is Claude → Ollama → LM Studio → rules, picked automatically (`backend/src/core/llm/`). See the README for setup.

## 6. Never
- Commit `.env`, tokens or real patient data. All demo data is synthetic.
- Edit another lane's files (see the table in §1). Ask via `REQUESTS.md`.
- Disable, skip or weaken tests to get green. Fix the cause.
- Let an LLM decide a clinical tier (the only exception is the escalate-only `riskllm` reviewer in §2).
