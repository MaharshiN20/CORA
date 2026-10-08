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
  messageId?,                                // provider message id (Twilio MessageSid): a repeat returns the first call's replies
  photo,                                     // …or { base64, mime }  (med-bottle photos, coming: P3-13)
}) → Promise<Reply[]>

startCheckin(patientId) → Promise<Reply[]>   // proactive start; send each via channels.sendToPatient

Reply  = { text, buttons?: Button[][], textEn?, urgent?: boolean, voice?: boolean }
Button = { label, data }                     // data ≤ 64 bytes, returned as buttonData when tapped
```
- Calls for one patient run strictly in arrival order (`withPatientLock`), so a double tap or a webhook retry can't finish a check-in twice. `startCheckin` queues in the same lane.
- Render `text` and `buttons` (rows). **Ignore `textEn`**; it's the English copy for the dashboard.
- `urgent: true` → emergency styling (bold, 🚨, pinned if possible).
- `voice: true` → also send a TTS voice note of `text` (the patient enabled voice mode).
- Button data prefixes the core emits: `ci:*` (check-in), `cmd:checkin`, `med:*` (medication confirmations, work any time), `rx:*` (refill barriers), `cmd:proxy` (caregiver answers for the patient, sent to caregivers), `lesson:*` (teach-back quiz answers), `sdoh:*` (social-needs screen), and later `sdoh:*`, `lesson:*`, `lang:*`. Pass every one through untouched.
- Caregiver messages: call `handleInbound({ role: 'caregiver', patientId })` with the *patient's* id. The core handles:
  `cmd:proxy` button or "check in"/"chequeo" → proxy check-in (questions in the caregiver's language, answers tagged `reporter: 'caregiver'`);
  `ci:*` taps during that proxy check-in; emergency phrases ("he has chest pain") → RED escalation + 911 reply to the caregiver; a medicine-change request → YELLOW dosing task (`reporter: caregiver`); a question → discharge companion in the caregiver's language; anything else → acknowledgement (i18n `caregiver_ack`).
- Check-in `ci:*` values: `ci:rf:none|chest|dizzy|confused|fainted`, `ci:breath:normal|exertion|rest`, `ci:orth:pillows|pnd|no` (legacy `ci:orth:yes` = pillows), `ci:swell:none|mild|worse`, `ci:diu:yes|later|no`, `ci:spo2:none`, `ci:wconf:yes|no`, `ci:wt:skip` (can't weigh today). A `ci:rf:chest|fainted|confused` or `ci:breath:rest` tap with no check-in running is still treated as an emergency. Button data for refills: `rx:<med>:<choice>`, or `rx:#<index>:<choice>` when the medication name would not fit in 64 bytes.
- A photo during the weight question is read by a vision model (if any) and always confirmed with `ci:wconf:*`; other photos are saved for the care team.
  Replies go back to the caregiver chat, in `caregiver.language`.

### Outbound: `channels/index.js` (Krish owns the implementation, core calls it)
```js
sendToPatient(patient, reply)   → Promise<boolean>   // logs to store, then delivers on the patient's channel
sendToCaregiver(patient, reply) → Promise<boolean>
sendToNurses(reply)             → Promise<boolean>   // nurse group (NURSE_CHAT_ID)
```
The adapter interface each channel implements: `{ name, isEnabled(), send(address, reply) }`.
Delivery failure returns `false` and never throws. The message is already in the dashboard log, with `delivery`: `sent` | `queued` (every channel failed; it is in the `outbox` collection and retried with backoff by `flushOutbox()` on each scheduler tick: 5 tries for routine messages, 12 for urgent / nurse ones) | `failed` (given up, audit `delivery_dead`) | `unlinked` (nothing to send to). `sendToNurses({ text, patientId?, alertId? })`: if the nurse message is queued the alert gets `undelivered: true` until a retry succeeds (audit `delivery_recovered`); nurses are reached on `NURSE_CHAT_ID` (Telegram) and, as a fallback, `NURSE_PHONE` (SMS/WhatsApp). With neither configured the dashboard is the channel and alerts are not flagged.

### Linking & enrollment: `store.js`, `core/enroll.js`
```js
store.linkChat(code, chatId)       → { role, patient } | null   // "GARCIA1" = patient, "CG_GARCIA1" = caregiver
store.findByChatId(chatId)         → { role, patient } | null
enrollDemoPatient({ chatId, language, name? }) → patient        // judge mode: clone of Maria, code DEMOxxxxx
createPatient({ name, age?, language?, profile?, meds?, prescriptions?, weights?, caregiver?, source? }) → patient
languages() → [{ code, name, nativeName, native }]              // native = offline templates (en, es)
store.updatePatient(id, { language | voiceMode | phone | channel })
```
Care codes are not master keys: once a patient/caregiver slot is linked, another chat/phone cannot take it over (the sender gets i18n `code_in_use`, audit `link_refused`, the nurse group is told) until a nurse calls `POST /api/patients/:id/unlink`. Outside production re-linking stays allowed unless `ALLOW_RELINK=0`. Unknown codes are throttled to 5 per chat/phone per 10 min. New codes (`createPatient`) are crypto-random.
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
  silentDays,            // days since the last finished check-in (or discharge); null in the first 3 days
}
```
```js
// riskllm/index.js (Maharshi): post-check-in reviewer. Escalate-only, never lowers, never RED.
reviewPatient(patient, { rules, messages, now }) → null | {
  rulesTier, aiTier, finalTier, escalate, urgent, readmissionRisk: 'low'|'moderate'|'high',
  concerns: [{ category, text, evidence }], nurseSummary, suggestedActions: string[], model, ts,
}
```
Overrides on top of the additive score: an open RED alert → High; `silentDays ≥ 3` → at least Med (+3 factor); dynamic points are capped at 10 (a negative "capped" factor keeps the sum honest); a Med/High patient stays there until 2 points below the cutoff (hysteresis, only when signals are given). The AI reviewer's `mergeTier` ignores unknown tiers, and it skips a patient who already has an open `ai_review` alert (stamp: `patient.lastAiReviewAt`).
`null` means no data yet, never zero. `scoreRisk(patient)` without signals must keep working (seed, tests).
The core calls `scoreRisk(patient, getSignals(patient))` for check-in depth and scheduling, and saves the result on the patient after each check-in. Seed patients carry a check-in history (`seeded: true`), so signals start realistic.
`core/aireview.js` already calls `risk.recordRisk(patient)` after every check-in **if that export exists**, and runs `reviewPatient` in the background only on GREEN days when the shared LLM chain has a provider.

---

## 3. Store: data every lane reads
The patient object (from `GET /api/patients/:id`, which also adds `signals`, `adherence: { overall, byMed: { [med]: { taken, missed, unknown, rate } }, unconfirmed }`, `messages`, `alerts`, `readings`, `audit`):
```js
{
  id, linkCode, name, age, language, condition: 'CHF', channel, chatId, phone?,
  dischargedAt, dryWeightLb, profile: { priorAdmits12mo, ejectionFraction, lengthOfStay, ckd, diabetes, copd, livesAlone },
  riskScore, riskTier, riskFactors,        // live Risk v2 (baseline + dynamic), re-saved after every check-in
  riskBaseline?, riskDynamic?,            // { score, factors } / { score, factors, trend }
  lastTier, lastCheckinAt, lastReplyAt, voiceMode, caregiverConsent,
  weights: [{ ts, lb }],
  doses: [{ id, ts, med, dose, diuretic, taken: true|false|null, source: 'reminder'|'checkin', reminderId?, respondedAt?, confirmedBy? }],
                                         // taken=null = unanswered reminder (never counted as missed)
  meds: [{ name, dose, times, diuretic? }],
  contactPhone?,                         // display only (tap-to-call on the worklist); `phone` is the SMS link
  labs?: { potassium, creatinine, at, source },   // standing-order eligibility (HF-02)
  vitals?: [{ ts, sbp, dbp, source }],   // e.g. a typed "118/72"
  prescriptions: [{ med, expectedPickup, pickedUpAt, barrier?: 'transport'|'cost'|'other', barrierAt?, nudges?: [iso], escalatedAt? }],
  checkin: { state, answers, startedAt, reporter: 'patient'|'caregiver', lang? }, checkins: [{ ts, answers, tier, flags, weight, reporter }],
                                         // step order: redflags -> weight -> breath -> orthopnea -> swelling -> diuretic -> spo2
                                         // answers may include pnd (woke up breathless), diureticAsked ("not yet today"), weightPending
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
| `audit` | `{ id, ts, type, patientId, data }`. New: `parse_trace` (every check-in input: `{ text|button, step, rules, llm: { fields (with evidence), dropped[], unverified[], timedOut, ms } | null, answers, outcome?: { tier, flags } }`, the Judge debug drawer), `red_lock` (message during the RED lock), `injection_attempt`, `protocol_applied`, `tier_cleared` (false alarm), `scenario`, `scale_photo`, `vital_reported`. Types include `triage`, `escalation`, `nurse_action`, `enroll`, `device_reading`, `photo_received`, `checkin_sent`, `checkin_abandoned`, `med_reminder`, `med_response`, `refill_nudge`, `refill_barrier`, `refill_picked_up`, `outreach` (`data.event`/`data.rung`), `outreach_recovered` (`data.afterRung`: the patient replied after the ladder fired, a recovery metric), `nurse_message`, `nurse_ack_notice`, `digest`, `ai_review` (`data.rulesTier/aiTier/finalTier/escalate/readmissionRisk/model`), `sdoh` (`data.event`: started\|answer\|completed), `lesson_sent`, `lesson_answer` (`data.lesson/correct/attempt`), `companion` (`data.kind`: answer\|nurse\|dosing, `data.via`: llm\|keywords, `data.sectionIds`), `job_failed`. `outreach_recovered.data.via` is `patient` or `caregiver` |
| `readings` | `{ id, ts, patientId, type: 'weight'\|'spo2'\|'hr', value, source: 'self'\|'device'\|'caregiver', device? }` |
| `device_links` (Krish) | `{ provider: 'withings', userId, patientId }`: which patient a device account belongs to (`routes/webhooks.js` `linkDevice` / `findDevicePatient`; audit `device_link`) |
| custom | `store.collection('<name>')` for lane-owned data (e.g. Maharshi's `cohort`). Call `store.persist()` after mutating |

- `alert.kind`: `triage | unreachable | refill | sdoh | question | med_discrepancy | device | protocol_followup`
- RED lock: for 1 h after a RED triage alert (or until it's resolved) every inbound message is answered with "call 911" and appended to that alert's `reasons`; routine jobs are skipped (`escalation.redLock`, scheduler `skipIf`)
- `GET /api/alerts` adds `protocolCheck` (see HF-02 below) to open YELLOW triage alerts that trigger a standing order; an applied one carries `protocol: { id, version, appliedAt, by, followUpTaskId }`
- `alert.status`: `open → acknowledged → contacted → resolved`
- `alert.outcome`: `true_positive | false_positive | ed_avoided | readmitted | other`
- SLA (`dueBy`): RED 15 min, YELLOW 4 h, INFO 24 h

**Live updates:** socket.io emits `change` with `{ type, payload }`, where type is one of `patient`, `message`, `alert`, `audit`, `reading`, `clock`, `reset`, `update`. The dashboard refetches on change.

---

## 4. REST API (backend :3001, proxied by Vite at `/api`)
Access: with `API_TOKEN` set, every `/api` route (except `/health`, `/ready`, `/join`) and the socket.io handshake need `Authorization: Bearer <token>` / `x-api-token` / `auth.token`. Unset = open. `/api/demo/*`, `/api/reset` and `/insights/cohort/regenerate` are 404 in production unless `DEMO_MODE=1`. Errors are JSON `{ error }`; JSON bodies are capped at 100 KB (10 MB on `/patients/:id/simulate`).
| Method & path | Owner | Notes |
|---|---|---|
| `GET /api/health` | P | `{ ok, telegram, llm: { provider, model, available }, now, demoOffsetMs }` |
| `GET /api/ready` | K | public, for load balancers and monitors (no tokens, ids, phone numbers or paths in it): `{ ready, checks: { store: { ok, error? }, scheduler: { ok, running, secondsSinceTick, pending, failed }, telegram: { ok, enabled, mode: off\|polling\|webhook\|refused\|failed }, twilio: { sms, whatsapp, signatureCheck }, llm: llm.status(), nurseChannel: { ok, via: [channel] }, outbox: { pending, dead } } }`. **503** (`ready: false`) only when the store can't be written; every other check degrades and carries its own `ok` |
| `GET /api/languages` | P | `languages()` |
| `GET /api/patients` | P | patients with `signals` |
| `GET /api/patients/:id` | P | patient + `signals`, `adherence`, `messages`, `alerts`, `readings`, `audit` |
| `POST /api/patients` | P | `createPatient` body → 201 |
| `POST /api/patients/:id/checkin` | P | start a check-in (sends via channel) |
| `POST /api/patients/:id/simulate` | P | `{ text?, buttonData?, role?, photo? }` → `Reply[]` (dashboard phone simulator); 400 when all are empty |
| `POST /api/patients/:id/message` | P | nurse → patient: `{ text, from? }` or `{ template: 'call_scheduled', time, from? }` / `{ template: 'ask_bp' }` → `{ delivered, translated (null for en, false = English body sent), language, text, textEn }`. Translated to the patient's language (English body kept if no LLM); 400 on empty/unknown template/missing time |
| `GET /api/patients/:id/digest?lang=` · `POST /api/patients/:id/digest` | P | weekly caregiver digest: preview `{ text }` / send now → `{ sent, delivered?, text?, textEn?, reason? }` (auto-sent Sundays 18:00) |
| `POST /api/patients/:id/sdoh/start` | P | send the 4-question social-needs screen now → `{ sent }` (auto-sent at the first noon ≥24h after discharge, once) |
| `POST /api/patients/:id/prescriptions/:med/picked-up` | P | `{ by? }` → updated prescription; resolves open refill tasks (pharmacy-feed stand-in / dashboard button) |
| `POST /api/patients/:id/unlink` | P | `{ role?: 'patient'\|'caregiver' }` → `{ ok, role }`; releases the chat/phone link so a new phone can JOIN |
| `GET /api/patients/:id/risk-history` | P | `[{ ts, score, tier }]` oldest first (last 200); one row per check-in and one per morning (`risk_snapshot` job, 06:00), so silent patients have a trajectory too |
| `GET /api/patients/:id/timeline?limit=200&kinds=` | P | the patient's story newest first. `kinds`: `checkin` (tier, flags, weight), `message` (direction, text, delivery), `alert` (alertId, tier, title, status), `reading`, `risk`, `event` (readable audit row). Limit ≤ 1000 |
| `GET /api/audit.csv?patientId=&type=&from=&to=&limit=` | P | audit log as `text/csv` (`ts,type,patientId,patientName,details`; details are JSON). Cells starting with `= + - @` are neutralised against spreadsheet formula injection |
| `GET /api/alerts` | P | worklist, newest first |
| `PATCH /api/alerts/:id` | P | `{ status?, outcome?, assignee?, note?, by? }`. First `acknowledged` on a RED/YELLOW triage/unreachable/device/question alert sends the patient "<nurse> saw your update" and sets `patientNotifiedAt`. Resolving a triage alert as `false_positive` recomputes the patient's `lastTier` |
| `POST /api/alerts/:id/protocol` | P | `{ by? }` → `{ alert, task, message, fhir: { medicationRequest, communicationRequest } }`; 409 `{ error, checks }` if not eligible. Standing order HF-02 (`conditions/chf/protocols/hf-02.json`, clinic-authored; demo values). `protocolCheck` = `{ protocol: { id, version, title, authoredBy, demo, disclaimer }, triggered, eligible, applied?, checks: [{ id, label, status: pass\|fail\|unknown, detail, required, action?: 'ask_bp' }] }` |
| `POST /api/devices/readings` | P | `{ patientId, type: 'weight'\|'spo2'\|'hr', value, device? (≤40 chars), ts? (ISO, ≤5 min ahead, ≤30 d old), readingId? (≤64, idempotent: a repeat → 200 with the original + `duplicate: true`) }` → 201 `{ ...reading, tier }`. Judged by `core/devicetriage.js` with the same rules as a check-in: SpO2 < 90 RED (COPD < 88), 90–92 YELLOW, HR outside 50–120 YELLOW, a weight joins `patient.weights` and runs the weight rules. Alerts carry `source: 'device reading'` and are de-bounced to one per hour per tier. `DEVICE_KEY` (header `x-device-key`) authenticates devices instead of the nurse token |
| `GET /api/demo/clock` · `POST /api/demo/reset` | P | demo clock; reset reseeds + replans jobs |
| `POST /api/demo/advance {hours}` | P | moves the clock, plans the skipped window, runs due jobs → `{ now, offsetMs, jobs: { ran, missed, failed } }` |
| `GET /api/demo/jobs?patientId=&status=&kind=` | P | scheduled jobs `{ id, key, kind, patientId, dueAt, status: pending\|running\|done\|missed\|failed\|cancelled, result?, error? }` |
| `POST /api/demo/tick` | P | run due jobs now → `{ ran, missed, failed }` |
| `GET /api/demo/scenarios` · `POST /api/demo/scenario/:name[?fast=1]` | P | `[{ name, title, description, tier: GREEN\|YELLOW\|RED\|SILENT, patientId, steps }]`; POST resets that patient to the seed and plays the conversation in the background (~1.2 s/step) → `{ name, patientId, steps, delayMs }`; `fast=1` plays instantly; 409 while that patient's scenario runs |
| `GET /api/join` | K | `{ bot, links: [{ language, name, nativeName, url }] }` for QR codes |
| `POST /webhooks/twilio/sms` · `/whatsapp` | K | form-encoded Twilio inbound (`From`, `Body`, media); `X-Twilio-Signature` checked when `TWILIO_AUTH_TOKEN` is set (fails closed in production) |
| `POST /webhooks/withings` | K | `{ userid, measuregrps: [{ grpid, attrib, date, category, measures: [{ value, type, unit }] }] }` (the shape of Withings' `getmeas` answer; weight kg → lb, pulse, SpO2) → 200 `{ ok, accepted: [{ readingId, type, value, tier }], duplicates, rejected: [{ grpid, type?, reason }] }`. Each measure takes the same path as `POST /api/devices/readings` (`core/devicetriage.js` `ingestReading`) with `readingId = withings:<grpid>:<type>`, so a repeated delivery stores nothing twice. Needs `X-Withings-Signature` = hex HMAC-SHA256 of the raw body keyed with `WITHINGS_CLIENT_SECRET` (403 otherwise; with no secret: open in dev, refused in production). 404 for a Withings user with no `device_links` row, 400 for a body that isn't that JSON. Out-of-range, undated, unattributed (`attrib` 1) and goal (`category` 2) measures are refused and audited (`device_rejected`) |
| `POST /webhooks/telegram` | K | Telegram webhook mode only (`TELEGRAM_WEBHOOK_URL`; long polling is the default and this route is then 404). Needs the `X-Telegram-Bot-Api-Secret-Token` header to equal `TELEGRAM_WEBHOOK_SECRET` (403 otherwise; required in production). A repeated `update_id` is answered 200 and ignored |
| `GET /api/insights/impact` · `/engagement` · `/equity` · `/roi` | M | `?source=cohort|live|all` (default all). `/impact` adds `projectedBasis` (`'synthetic'` when any cohort journey is involved: the cohort has the engaged/not-engaged gap built in, so the avoided-readmissions figure is an assumption; `'observed'` for live-only; `null` for no data), `sampleIsSmall` (< 10 known outcomes), `alerts.actionable` (non-INFO) and `alerts.pendingWithinSla`; live `readmitted` is `null` until the 30-day window closes, `false` only after it. `/roi` clamps each input to a sane range and lists what it clamped in `clamped`. `/roi` takes `discharges, readmitRate, costPerReadmit, reduction, penaltyPct, medicareRevenue, tcmContactRate, tcmHighComplexityShare, rpmEligibleRate`; TCM/RPM rates default to measured values |
| `POST /api/insights/cohort/regenerate` | M | `{ seed?, size? }` → `{ ok, seed, size }`. The synthetic cohort lives in `store.collection('cohort')`, never in patients |
| `GET /api/fhir/search?name=` | M | `[{ fhirId, name, age, birthDate, gender, language, importedAs }]` from the FHIR R4 server (`FHIR_BASE_URL`, default public HAPI sandbox; read-only) |
| `GET /api/fhir/preview/:fhirId` | M | `{ data, summary }`: what an import would create (meds, conditions, warnings); saves nothing |
| `POST /api/fhir/import` | M | `{ fhirPatientId, override? }` → 201 `{ patient, summary }` via `createPatient({ ..., source: 'fhir' })`; 409 `{ patientId }` if already imported; 422 `{ needsOverride, reasons }` for no heart-failure diagnosis / under 18 unless `override: true`; 404 / 422 (no name) / 502 (EHR down) |
| `GET /api/fhir/export/:patientId` | M | FHIR R4 collection Bundle preview (Patient, weight/SpO2/BP Observations, Flag, Tasks); nothing is sent |

## 5. LLM chain (core-internal, but everyone may call it)
```js
import * as llm from '../core/llm/index.js';
llm.enabled() → boolean; llm.status() → { provider, model, available }
llm.complete(system, user, maxTokens?, { json?, schema?, model?, timeoutMs? }) → Promise<string | null>
llm.completeJSON(system, user, { maxTokens?, schema?, model?, timeoutMs?, deadlineMs? }) → Promise<object | null>
// chain: Claude -> Gemini -> Ollama -> LM Studio; `model` is used only by a provider that has it;
// 503/429 are retried once per provider, then the next provider is tried
// deadlineMs caps the WHOLE chain (patient-facing parsing uses 4 s, then rules take over)
llm.visionEnabled() → boolean   // some provider can read images (Gemini, Claude, local *-vl / llava / gemma-3)
llm.completeVisionJSON(system, prompt, { base64, mime }, opts?) → Promise<object | null>   // text-only providers are skipped
parser.parseWithLLM(text, { step? }) → flat answers | null   // evidence-checked (parser.validateExtraction)
```
Always handle `null`. That's the no-LLM path, and it must work.

## 6. Languages
`t(lang, key, vars)` is sync (en/es hand-written). `localize(lang, text)` translates English produced by `t()` using `src/core/i18n-generated/<lang>.json` templates first (offline), then the LLM chain, then returns English. `translateFromEnglish(lang, text)` is for free text (e.g. nurse messages). New patient-facing keys need en + es in `core/i18n.js`. Run `npm --prefix backend run i18n:build -- --langs <codes>` to refresh generated languages.
