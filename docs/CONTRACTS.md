# Contracts

These are the interfaces between lanes. `backend/test/contracts.test.js` enforces them.
**Change a contract only via `docs/team/REQUESTS.md`**, then update this file and the contract test in the same commit.
"(coming: Pn)" means the shape is fixed now and Prannav's lane fills it in at that task.

---

## 1. Channel ⇄ core (Krish ⇄ Prannav)

### Inbound: `core/agent.js`
```js
handleInbound({
  patientId,                                 // required, resolve with store.findByChatId(chatId)
  role = 'patient',                          // 'patient' | 'caregiver'
  channel,                                   // 'telegram' | 'sms' | 'whatsapp' | 'sim'
  text, buttonData, voiceTranscript,         // any one of these…
  photo,                                     // …or { base64, mime }  (med-bottle photos, coming: P3-13)
}) → Promise<Reply[]>

startCheckin(patientId) → Promise<Reply[]>   // proactive start; send each via channels.sendToPatient

Reply  = { text, buttons?: Button[][], textEn?, urgent?: boolean, voice?: boolean }
Button = { label, data }                     // data ≤ 64 bytes, returned as buttonData when tapped
```
- Render `text` and `buttons` (rows). **Ignore `textEn`**; it's the English copy for the dashboard.
- `urgent: true` → emergency styling (bold, 🚨, pinned if possible).
- `voice: true` → also send a TTS voice note of `text` (the patient enabled voice mode).
- Button data prefixes the core emits: `ci:*` (check-in), `cmd:checkin`, `med:*` (medication confirmations, work any time), `rx:*` (refill barriers), `cmd:proxy` (caregiver answers for the patient, sent to caregivers), `lesson:*` (teach-back quiz answers), `sdoh:*` (social-needs screen), and later `sdoh:*`, `lesson:*`, `lang:*`. Pass every one through untouched.
- Caregiver messages: call `handleInbound({ role: 'caregiver', patientId })` with the *patient's* id. The core handles:
  `cmd:proxy` button or "check in"/"chequeo" → proxy check-in (questions in the caregiver's language, answers tagged `reporter: 'caregiver'`);
  `ci:*` taps during that proxy check-in; emergency phrases ("he has chest pain") → RED escalation + 911 reply to the caregiver; anything else → acknowledgement.
  Replies go back to the caregiver chat, in `caregiver.language`.

### Outbound: `channels/index.js` (Krish owns the implementation, core calls it)
```js
sendToPatient(patient, reply)   → Promise<boolean>   // logs to store, then delivers on the patient's channel
sendToCaregiver(patient, reply) → Promise<boolean>
sendToNurses(reply)             → Promise<boolean>   // nurse group (NURSE_CHAT_ID)
```
The adapter interface each channel implements: `{ name, isEnabled(), send(address, reply) }`.
Delivery failure returns `false` and never throws. The message is already in the dashboard log.

### Linking & enrollment: `store.js`, `core/enroll.js`
```js
store.linkChat(code, chatId)       → { role, patient } | null   // "GARCIA1" = patient, "CG_GARCIA1" = caregiver
store.findByChatId(chatId)         → { role, patient } | null
enrollDemoPatient({ chatId, language, name? }) → patient        // judge mode: clone of Maria, code DEMOxxxxx
createPatient({ name, age?, language?, profile?, meds?, prescriptions?, weights?, caregiver?, source? }) → patient
languages() → [{ code, name, nativeName, native }]              // native = offline templates (en, es)
store.updatePatient(id, { language | voiceMode | phone | channel })
```
Deep links: `https://t.me/<bot>?start=GARCIA1`, `?start=CG_GARCIA1`, `?start=DEMO_ES` (see `GET /api/join`).

### Speech (Krish provides `integrations/speech.js`)
```js
transcribe(buffer, mime, languageHint?) → Promise<string | null>   // null = unavailable, ask to type
tts(text, language) → Promise<{ url } | { buffer, mime } | null>
```

---

## 2. Risk (Maharshi ⇄ Prannav)
```js
// core/risk.js (Maharshi)
scoreRisk(patient, signals?, { previousScore? }) → {
  score: number, tier: 'Low' | 'Med' | 'High',
  factors: [{ label, points }],          // baseline + dynamic, human-readable, shown on dashboard
  plan: { checkinsPerDay, askSpo2, askOrthopnea },   // drives check-in depth (core relies on these keys)
  baseline: { score, factors },          // discharge-time factors (never change)
  dynamic?: { score, factors, trend: 'up' | 'down' | 'flat' },  // only when signals given; trend vs previousScore (default patient.riskScore)
}
recordRisk(patient, signals?) → Promise<row | null>   // core/risk.js entry point (aireview.js calls it after each check-in); delegates below
// insights/riskHistory.js (Maharshi): risk over time.
recordRisk(patient, signals = getSignals(patient)) → { ts, patientId, score, tier }   // appends to store.collection('riskHistory')
currentRisk(patient, signals?) → scoreRisk result, trend vs the last riskHistory row
riskHistory(patientId) → rows oldest → newest;  lastRisk(patientId) → row | null
// core/signals.js (Prannav)
getSignals(patient) → {
  daysSinceDischarge, checkinsCompleted7d, missedCheckins7d,
  adherence7d: 0..1 | null, unconfirmedDoses7d, weightDelta24h, weightDelta7d,
  openAlerts, openRedAlerts, sdohFlags: string[], lessonScore: 0..1 | null,
  rpmDays30, lastCheckinAt, lastTier,
}
```
```js
// riskllm/index.js (Maharshi): post-check-in reviewer. Escalate-only, never lowers, never RED.
reviewPatient(patient, { rules, messages, now }) → null | {
  rulesTier, aiTier, finalTier, escalate, urgent, readmissionRisk: 'low'|'moderate'|'high',
  concerns: [{ category, text, evidence }], nurseSummary, suggestedActions: string[], model, ts,
}
```
`null` means no data yet, never zero. `scoreRisk(patient)` without signals must keep working (seed, tests).
The core calls `scoreRisk(patient)` today. Once Risk v2 lands, the core will call `scoreRisk(patient, getSignals(patient))`.
`core/aireview.js` already calls `risk.recordRisk(patient)` after every check-in **if that export exists**, and runs `reviewPatient` in the background only on GREEN days when the shared LLM chain has a provider.

---

## 3. Store: data every lane reads
The patient object (from `GET /api/patients/:id`, which also adds `signals`, `adherence: { overall, byMed: { [med]: { taken, missed, unknown, rate } }, unconfirmed }`, `messages`, `alerts`, `readings`, `audit`):
```js
{
  id, linkCode, name, age, language, condition: 'CHF', channel, chatId, phone?,
  dischargedAt, dryWeightLb, profile: { priorAdmits12mo, ejectionFraction, lengthOfStay, ckd, diabetes, copd, livesAlone },
  riskScore, riskTier, riskFactors, lastTier, lastCheckinAt, lastReplyAt, voiceMode, caregiverConsent,
  weights: [{ ts, lb }],
  doses: [{ id, ts, med, dose, diuretic, taken: true|false|null, source: 'reminder'|'checkin', reminderId?, respondedAt?, confirmedBy? }],
                                         // taken=null = unanswered reminder (never counted as missed)
  meds: [{ name, dose, times, diuretic? }],
  prescriptions: [{ med, expectedPickup, pickedUpAt, barrier?: 'transport'|'cost'|'other', barrierAt?, nudges?: [iso], escalatedAt? }],
  checkin: { state, answers, startedAt, reporter: 'patient'|'caregiver', lang? }, checkins: [{ ts, answers, tier, flags, weight, reporter }],
  caregiver: { name, relation, language, chatId },
  dischargeInstructions,                 // optional hospital free text
  carePlan: { fluidLimitL, sodiumMg },   // drives the personalised discharge instructions (companion)
  followUp: { with, at },                // follow-up appointment
  sdoh?: { flags: string[], answers: { ride, cost, food, help }, pending: [q], startedAt, screenedAt },
                                         // flags: transportation | medication_cost | food_insecurity | social_isolation
  lessons?: { sent: [id], queue: [id], answers: { [id]: { attempts, correct, firstCorrect, answeredAt } }, score }, // score = first-try correct share
  source: 'seed' | 'demo' | 'fhir' | 'manual',
}
```
Other collections:
| Collection | Shape |
|---|---|
| `messages` | `{ id, ts, patientId, direction: 'in'\|'out', from?, to: 'patient'\|'caregiver'\|'nurse', text, textEn?, buttons?, channel? }` |
| `alerts` (nurse worklist) | `{ id, ts, patientId, kind, tier: 'RED'\|'YELLOW'\|'INFO', title, reasons[], status, dueBy, assignee, outcome, note?, history: [{ ts, status, by }], source?, priority?, reporter?: 'patient'\|'caregiver', med?, barrier? }`. AI-review alerts (`source: 'ai_review'`, YELLOW, only ever on a GREEN rules day) carry `nurseSummary`, `suggestedActions[]`, `readmissionRisk`, `model`; reasons quote the patient's words as evidence. SDOH tasks (kind `sdoh`, INFO) carry `needs[]` (the flags). Question tasks (discharge companion) carry `question` (original text) and `dosing` (true = medication-change question, YELLOW). Unreachable tasks (outreach ladder, YELLOW) carry `silentDays`. Refill tasks carry `med` + `barrier` (`transport\|cost\|other\|no_response`) |
| `audit` | `{ id, ts, type, patientId, data }`. Types include `triage`, `escalation`, `nurse_action`, `enroll`, `device_reading`, `photo_received`, `checkin_sent`, `checkin_abandoned`, `med_reminder`, `med_response`, `refill_nudge`, `refill_barrier`, `refill_picked_up`, `outreach` (`data.event`/`data.rung`), `outreach_recovered` (`data.afterRung`: the patient replied after the ladder fired, a recovery metric), `nurse_message`, `nurse_ack_notice`, `digest`, `ai_review` (`data.rulesTier/aiTier/finalTier/escalate/readmissionRisk/model`), `sdoh` (`data.event`: started\|answer\|completed), `lesson_sent`, `lesson_answer` (`data.lesson/correct/attempt`), `companion` (`data.kind`: answer\|nurse\|dosing, `data.via`: llm\|keywords, `data.sectionIds`), `job_failed`. `outreach_recovered.data.via` is `patient` or `caregiver` |
| `readings` | `{ id, ts, patientId, type: 'weight'\|'spo2'\|'hr', value, source: 'self'\|'device'\|'caregiver', device? }` |
| custom | `store.collection('<name>')` for lane-owned data (e.g. Maharshi's `cohort`). Call `store.persist()` after mutating |

- `alert.kind`: `triage | unreachable | refill | sdoh | question | med_discrepancy | device`
- `alert.status`: `open → acknowledged → contacted → resolved`
- `alert.outcome`: `true_positive | false_positive | ed_avoided | readmitted | other`
- SLA (`dueBy`): RED 15 min, YELLOW 4 h, INFO 24 h

**Live updates:** socket.io emits `change` with `{ type, payload }`, where type is one of `patient`, `message`, `alert`, `audit`, `reading`, `clock`, `reset`, `update`. The dashboard refetches on change.

---

## 4. REST API (backend :3001, proxied by Vite at `/api`)
| Method & path | Owner | Notes |
|---|---|---|
| `GET /api/health` | P | `{ ok, telegram, llm: { provider, model, available }, now, demoOffsetMs }` |
| `GET /api/languages` | P | `languages()` |
| `GET /api/patients` | P | patients with `signals` |
| `GET /api/patients/:id` | P | patient + `signals`, `adherence`, `messages`, `alerts`, `readings`, `audit` |
| `POST /api/patients` | P | `createPatient` body → 201 |
| `POST /api/patients/:id/checkin` | P | start a check-in (sends via channel) |
| `POST /api/patients/:id/simulate` | P | `{ text?, buttonData?, role?, photo? }` → `Reply[]` (dashboard phone simulator) |
| `POST /api/patients/:id/message` | P | nurse → patient: `{ text, from? }` or `{ template: 'call_scheduled', time, from? }` → `{ delivered, text, textEn }`. Translated to the patient's language (English body kept if no LLM); 400 on empty/unknown template/missing time |
| `GET /api/patients/:id/digest?lang=` · `POST /api/patients/:id/digest` | P | weekly caregiver digest: preview `{ text }` / send now → `{ sent, delivered?, text?, textEn?, reason? }` (auto-sent Sundays 18:00) |
| `POST /api/patients/:id/sdoh/start` | P | send the 4-question social-needs screen now → `{ sent }` (auto-sent at the first noon ≥24h after discharge, once) |
| `POST /api/patients/:id/prescriptions/:med/picked-up` | P | `{ by? }` → updated prescription; resolves open refill tasks (pharmacy-feed stand-in / dashboard button) |
| `GET /api/alerts` | P | worklist, newest first |
| `PATCH /api/alerts/:id` | P | `{ status?, outcome?, assignee?, note?, by? }`. First `acknowledged` on a RED/YELLOW triage/unreachable/device/question alert sends the patient "<nurse> saw your update" and sets `patientNotifiedAt` |
| `POST /api/devices/readings` | P | `{ patientId, type, value, device?, ts? }` → 201 (triage on readings, coming: P3-14) |
| `GET /api/demo/clock` · `POST /api/demo/reset` | P | demo clock; reset reseeds + replans jobs |
| `POST /api/demo/advance {hours}` | P | moves the clock, plans the skipped window, runs due jobs → `{ now, offsetMs, jobs: { ran, missed, failed } }` |
| `GET /api/demo/jobs?patientId=&status=&kind=` | P | scheduled jobs `{ id, key, kind, patientId, dueAt, status: pending\|running\|done\|missed\|failed\|cancelled, result?, error? }` |
| `POST /api/demo/tick` | P | run due jobs now → `{ ran, missed, failed }` |
| `GET /api/demo/scenarios` · `POST /api/demo/scenario/:name` | P | list is `[]` until P4-15. Render whatever it returns |
| `GET /api/join` | K | `{ bot, links: [{ language, name, nativeName, url }] }` for QR codes |
| `POST /webhooks/twilio/sms` · `/whatsapp` | K | coming: K5 |
| `GET /api/insights/impact` · `/engagement` · `/equity` · `/roi` | M | `?source=cohort|live|all` (default all). `/roi` takes `discharges, readmitRate, costPerReadmit, reduction, penaltyPct, medicareRevenue, tcmContactRate, tcmHighComplexityShare, rpmEligibleRate`; TCM/RPM rates default to measured values |
| `POST /api/insights/cohort/regenerate` | M | `{ seed?, size? }` → `{ ok, seed, size }`. The synthetic cohort lives in `store.collection('cohort')`, never in patients |
| `GET /api/fhir/search?name=` | M | `[{ fhirId, name, age, birthDate, gender, language, importedAs }]` from the FHIR R4 server (`FHIR_BASE_URL`, default public HAPI sandbox; read-only) |
| `GET /api/fhir/preview/:fhirId` | M | `{ data, summary }`: what an import would create (meds, conditions, warnings); saves nothing |
| `POST /api/fhir/import` | M | `{ fhirPatientId }` → 201 `{ patient, summary }` via `createPatient({ ..., source: 'fhir' })`; 409 `{ patientId }` if already imported; 404 / 422 (no name) / 502 (EHR down) |

## 5. LLM chain (core-internal, but everyone may call it)
```js
import * as llm from '../core/llm/index.js';
llm.enabled() → boolean; llm.status() → { provider, model, available }
llm.complete(system, user, maxTokens?, { json?, schema?, model?, timeoutMs? }) → Promise<string | null>
llm.completeJSON(system, user, { maxTokens?, schema?, model?, timeoutMs? }) → Promise<object | null>
// chain: Claude -> Gemini -> Ollama -> LM Studio; `model` is used only by a provider that has it;
// 503/429 are retried once per provider, then the next provider is tried
llm.completeVision(system, prompt, { base64, mime }) → Promise<string | null>   // coming: P3-13
```
Always handle `null`. That's the no-LLM path, and it must work.

## 6. Languages
`t(lang, key, vars)` is sync (en/es hand-written). `localize(lang, text)` translates English produced by `t()` using `src/core/i18n-generated/<lang>.json` templates first (offline), then the LLM chain, then returns English. `translateFromEnglish(lang, text)` is for free text (e.g. nurse messages). New patient-facing keys need en + es in `core/i18n.js`. Run `npm --prefix backend run i18n:build -- --langs <codes>` to refresh generated languages.
