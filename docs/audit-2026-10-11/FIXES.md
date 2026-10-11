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

## Not fixed (and why)

- **Other lanes** (REQUESTS.md): S7 the 7B risk reviewer (Maharshi), eval rows for the new phrasings and an out-of-sample set (Maharshi), the 815 kB dashboard chunk (Maharshi).
- **Still model-only**: Korean, Arabic, Portuguese, Tagalog, Haitian Creole have no rule lists; they rely on the model second opinion plus the "call 911 if..." line when the model is unhealthy. Writing and **native-speaker review** of those lists, and of the vi / hi / zh lists and every clinical threshold, cannot be automated.
- **Rules are still not "100%"**: 97/97 is on the audit's own phrasings. Do not quote a recall number until someone who did not write the rules supplies the test set.
- `GET /patients` recomputes risk per request, demo clock advance blocks for ~10 s at 500 patients, scheduling uses the server's time zone: unchanged, untested here.
- `npm audit`: `axios` via `google-tts-api` (fix is a breaking downgrade): unchanged.
- Not tested: dashboard in a real browser, real Telegram / Twilio, the LM Studio scripts after these changes.
