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
- Button data prefixes the core emits: `ci:*` (check-in), `cmd:checkin`, and later `med:*`, `rx:*`, `sdoh:*`, `lesson:*`, `lang:*`. Pass every one through untouched.
- Caregiver messages: call `handleInbound({ role: 'caregiver', patientId })` with the *patient's* id (proxy check-in, coming: P1-7).

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
scoreRisk(patient, signals?) → {
  score: number, tier: 'Low' | 'Med' | 'High',
  factors: [{ label, points }],          // human-readable, shown on dashboard
  plan: { checkinsPerDay, askSpo2, askOrthopnea },   // drives check-in depth (core relies on these keys)
  dynamic?: { score, factors, trend: 'up' | 'down' | 'flat' },  // behaviour-based component
}
// core/signals.js (Prannav)
getSignals(patient) → {
  daysSinceDischarge, checkinsCompleted7d, missedCheckins7d,
  adherence7d: 0..1 | null, weightDelta24h, weightDelta7d,
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

---

## 3. Store: data every lane reads
The patient object (from `GET /api/patients/:id`, which also adds `signals`, `messages`, `alerts`, `readings`, `audit`):
```js
{
  id, linkCode, name, age, language, condition: 'CHF', channel, chatId, phone?,
  dischargedAt, dryWeightLb, profile: { priorAdmits12mo, ejectionFraction, lengthOfStay, ckd, diabetes, copd, livesAlone },
  riskScore, riskTier, riskFactors, lastTier, lastCheckinAt, voiceMode, caregiverConsent,
  weights: [{ ts, lb }], doses: [{ ts, med, diuretic, taken }],
  meds: [{ name, dose, times, diuretic? }],
  prescriptions: [{ med, expectedPickup, pickedUpAt, barrier? /* coming: P1-4 */ }],
  checkin: { state, answers }, checkins: [{ ts, answers, tier, flags, weight }],
  caregiver: { name, relation, language, chatId },
  dischargeInstructions,                 // coming: P2-8
  sdoh?: { flags: string[], answers },   // coming: P2-10
  lessons?: { score, completed: [] },    // coming: P2-9
  source: 'seed' | 'demo' | 'fhir' | 'manual',
}
```
Other collections:
| Collection | Shape |
|---|---|
| `messages` | `{ id, ts, patientId, direction: 'in'\|'out', from?, to: 'patient'\|'caregiver'\|'nurse', text, textEn?, buttons?, channel? }` |
| `alerts` (nurse worklist) | `{ id, ts, patientId, kind, tier: 'RED'\|'YELLOW'\|'INFO', title, reasons[], status, dueBy, assignee, outcome, note?, history: [{ ts, status, by }], source?, priority? }` |
| `audit` | `{ id, ts, type, patientId, data }`. Types include `triage`, `escalation`, `nurse_action`, `enroll`, `device_reading`, `photo_received`, later `outreach`, `refill_nudge`, `llm_parse` |
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
| `GET /api/patients/:id` | P | patient + `signals`, `messages`, `alerts`, `readings`, `audit` |
| `POST /api/patients` | P | `createPatient` body → 201 |
| `POST /api/patients/:id/checkin` | P | start a check-in (sends via channel) |
| `POST /api/patients/:id/simulate` | P | `{ text?, buttonData?, role?, photo? }` → `Reply[]` (dashboard phone simulator) |
| `POST /api/patients/:id/message` | P | coming: P1-6. Nurse → patient `{ text }` |
| `GET /api/alerts` | P | worklist, newest first |
| `PATCH /api/alerts/:id` | P | `{ status?, outcome?, assignee?, note?, by? }` |
| `POST /api/devices/readings` | P | `{ patientId, type, value, device?, ts? }` → 201 (triage on readings, coming: P3-14) |
| `GET /api/demo/clock` · `POST /api/demo/advance {hours}` · `POST /api/demo/reset` | P | demo clock |
| `GET /api/demo/scenarios` · `POST /api/demo/scenario/:name` | P | list is `[]` until P4-15. Render whatever it returns |
| `POST /api/demo/tick` | P | coming: P1-2. Run due scheduler jobs |
| `GET /api/join` | K | `{ bot, links: [{ language, name, nativeName, url }] }` for QR codes |
| `POST /webhooks/twilio/sms` · `/whatsapp` | K | coming: K5 |
| `GET /api/insights/*` | M | coming: M2 (`/impact`, `/engagement`, `/equity`, `/roi`) |
| `POST /api/fhir/import` | M | coming: M5 |

## 5. LLM chain (core-internal, but everyone may call it)
```js
import * as llm from '../core/llm/index.js';
llm.enabled() → boolean; llm.status() → { provider, model, available }
llm.complete(system, user, maxTokens?) → Promise<string | null>
llm.completeJSON(system, user) → Promise<object | null>
llm.completeVision(system, prompt, { base64, mime }) → Promise<string | null>   // coming: P3-13
```
Always handle `null`. That's the no-LLM path, and it must work.
