# Audit 2026-10-11: what was fixed, what was not

Backend suite 922 -> 1079 tests, frontend 127, build green (`npm run check`). One commit per finding group; each
has its own test file. Re-run the audit scripts in `scripts/` against a real model to confirm the live numbers
(`t_rules`, `t_csrf` and the unit tests were re-run here; the LM Studio scripts were not).

| Finding | Status | Where | Test |
|---|---|---|---|
| S1 nurse text lost for 6 languages | fixed: wrapper assembled in code, no sentinel through the model | `core/nurse.js`, `core/i18n.js` | `translation.trust.test.js` |
| S1b unvalidated model output delivered and cached | fixed: numbers / 911 / script / length checked; bad output never cached; English + `translated:false` instead; temperature 0, 6 s deadline | `core/i18n.js` (`plausibleTranslation`) | `translation.trust.test.js` |
| S5 hung or slow model stalls patients | fixed: circuit breaker (2 failures -> 30 s "no model"), so the 911 safety-net line and rules take over; companion + translation deadlines | `core/llm/index.js` | `llm.breaker.test.js` |
| S3 calm "no X or Y" = 911 | fixed: negation scopes over a negated symptom list in en/es/vi/hi/zh; questions, hypotheticals, side effects and old history are not emergencies unless they say "now" | `core/parser.js`, `core/redflags-intl.js` | `parser.negation.test.js` |
| S2 companion answers 0/35 with the model on | fixed: keyword retrieval first, model second, keywords again if the model says "other" | `core/companion.js` | `companion.test.js` |
| S4 missed emergencies | fixed for the 97-phrase audit set (74 -> 97): canonical text (look-alikes, zero-width, leet, typos), wider proximity, collapse / unresponsive / dying vocabulary in 5 languages, new triage reasons; the model is now a second opinion for every language (escalate-only) | `core/parser.js`, `core/redflags-intl.js`, `core/checkin.js`, `core/triage.js` | `redflags.fresh.test.js` |
| S5b check-in dead ends | fixed: a model false/false or a plain "no" in any language answers the red-flag question; flat model JSON is kept (flagged unverified) | `core/checkin.js`, `core/parser.js` | `parser.llm.test.js` |
| S5c questions swallowed in a check-in | fixed | `core/checkin.js`, `core/agent.js` | `checkin.question.test.js` |
| S6 open API exploitable from any web page | fixed without requiring a key: urlencoded only on `/webhooks`; foreign Origin = 403; dev CORS = local origins; non-local Host = 421 in dev (`ALLOWED_HOSTS`) | `app.js`, `security.js` | `security.csrf.test.js` |
| S8 prompt injection | fixed: instruction text is cut out before a model reads the message; machine talk is not a symptom to the rules | `core/injection.js`, `core/parser.js` | `injection.test.js` |
| API 500s, 100 KB messages (§6) | fixed: types validated (400), generic 500, inbound text capped at 4000 | `routes/api.js`, `core/agent.js`, `core/nurse.js` | `security.csrf.test.js` |
| Dosing regex: "less salt with my pills", "exact dose of" | fixed | `core/companion.js` | `companion.test.js` |
| Names translated ("Fresh" -> "鲜鲜") | prompt now forbids it (not verifiable without a model) | `core/i18n.js` | none |

## Second pass (everything that was left), and live verification

| Item | Status |
|---|---|
| S7 weak 7B reviewer | steady creep is now a triage rule (`weight_creep`, YELLOW) so rules own it; the eval's creep rows became "hold". Live LM Studio reviewer: recall 100%, precision 82% on the 18 cases the rules leave (signals stub 83/83). It is still not a differentiator: 4 false alarms of 17 |
| eval rows | 37 audit rows added (they caught a real miss, "se desplomó"); labelled as written by the rules' author |
| dashboard chunk | main bundle 815 kB -> 298 kB (lazy routes, SVG sparkline); no Vite warning; dashboard checked in Chrome (worklist, Impact) |
| ko / ar / pt / tl / ht rules | `core/redflags-more.js` (unreviewed), plus hand-written "call 911" sentences (`core/urgent-fallback.js`, unreviewed) so these patients get their own language instantly |
| `GET /patients` cost | cached until the store changes (`store.revision()`) or the clock moves a minute |
| demo clock jump | 72 h at 500 patients: 9.8 s -> 0.58 s (the scheduler no longer rescans every retained job per job; 87 s -> 0.4 s on a 76k-job backlog) |
| time zones | `patient.timezone` (IANA) drives check-ins, meds, refills, lessons, digest, SDOH, protocol follow-up, "today" in signals and triage; none = server time as before. DST tested |
| `npm audit` | `google-tts-api` (only axios user) replaced by a 20-line URL builder: 0 vulnerabilities |
| names translated | guard: a name after Hi / Nurse / Dr. must survive (`plausibleTranslation`) |
| translation decoration | emoji the nurse did not write are rejected |
| found while verifying | a model returning `sourceIds` as a string crashed the companion (500 on a long Korean message): fixed, and every handler failure now answers "didn't catch that" + the 911 line |

Live re-run against LM Studio (qwen2.5-7b-instruct), same scripts as the audit:

| Audit number | Before | After |
|---|---|---|
| Calm "no X or Y" answers wrongly 911 | 7 / 25 | 0 / 25 |
| Fresh-phrasing emergencies missed (97 phrasings, rules) | 23 wrong | 0 |
| Idle-patient emergencies missed, 24 messages in 5 languages | rules-only 10 / 14, model 10 | 0 / 24 both |
| Companion answered with the model on | 0 / 35 | 26 / 35 (the other 9 are dosing / nurse / off-topic by design) |
| Hung model: Korean emergency | 184 s, no RED | 2 ms to RED; 5.0 s worst case on a first message, then the breaker opens |
| Korean suppression / forgery injection | no RED / false RED pages | RED fires / no alert, in 5 of 5 languages |
| Free-text check-in in zh | never finished | finishes in all four languages tested |
| API fuzz (1,309 requests) | 43 server errors | 0 |
| Cross-site form POSTs | all succeeded | all 403; Host evil 421 |
| Crash durability, 1,000 messages @ 40 concurrent | fine | still fine (0 errors, p95 53 ms) |

## Still not done (cannot be, from here)

- **Native-speaker and clinician review** of every phrase list (vi, hi, zh, ko, ar, pt, tl, ht), the 911 sentences, the generated templates and all clinical thresholds (including the new creep rule). Everything new here says "unreviewed" in its own file.
- **Generated templates for ko / ar / pt / tl / ht** (`npm run i18n:build`): the run through Gemini was too slow to finish and a 7B model's Arabic or Haitian Creole is not good enough to ship, so those languages still send English for non-emergency system text. Run it with a stronger model, then have it reviewed.
- Translation fidelity is still model-limited: with qwen2.5-7b about half of the nurse messages in ko / ar / pt / tl / ht fail the checks and go out in English with `translated:false` (safe, not good).
- Not tested: real Telegram / Twilio / WhatsApp / Groq / Withings, voice and photo with real media, long soaks, multi-instance deployments, HIPAA / privacy review, XSS in the dashboard from patient text, screen readers and mobile layouts.
- The recall numbers above are on phrasings the same author wrote. Treat them as regression guards; do not quote a recall figure until someone independent supplies the test set.
