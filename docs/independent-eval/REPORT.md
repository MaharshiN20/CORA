# Independent red-flag test and bug hunt

**Date:** 2026-10-11 · **Build:** `main` at `fd813de` plus this work · **By:** Krish's Claude (claude-opus-5-5). No human, native speaker or clinician reviewed any of it.

## In short

- **On messages the rules' author did not write, the rules alone catch about 4 emergencies in 10.** Working batch: 169 of 414 (40.8%). Held-out batch: 68 of 198 (34.3%). False alarms: 9.4% and 8.5% of calm messages. The live path with no model gives exactly the same numbers. "0 missed emergencies" described the author's own phrases; it should not be quoted.
- **A local model as second opinion helps, and not enough**: with LM Studio (qwen2.5-7b) on, the working batch went from 40.8% to 53.9% of emergencies caught, and from 9.4% to 11.3% false alarms.
- **There are no "after" numbers.** The rules live in Prannav's lane and he has not confirmed in writing that I may edit them, so I changed none. The misses are logged as general fix classes in `docs/team/REQUESTS.md`. The held-out batch is still unread and must stay so until those fixes are in.
- **Bugs: 7 fixed** (all in channels, each with a test that failed first), **8 left open** in other lanes (logged, 6 of them with a `todo` test). The most serious open one: a crash within 250 ms of a "call 911" reply loses the RED alert.
- What held: about 11,600 fuzzed messages with no 5xx from a patient message, a reply to every message, no stuck check-in and no duplicate check-ins or alerts; concurrency, midnight, the daylight-saving change, `API_TOKEN`, the Origin and Host guards and the injection cases.

## 1. Red-flag numbers

The set, who wrote it and how labels were corrected: `evals/independent-README.md`. An emergency is a message where the right answer is "call 911 now"; "caught" means the system said so. A false alarm is a calm message that got the 911 reply.

### Before (code as of `fd813de`; nothing in the rules was changed)

| Batch | Path | Emergencies caught | False alarms on calm messages |
|---|---|---|---|
| Working, 873 messages | rules only (`parseFreeText`) | 169 / 414 (**40.8%**) | 43 / 459 (**9.4%**) |
| Working, 873 messages | live, `POST /simulate`, `LLM_PROVIDER=none` | 169 / 414 (40.8%) | 43 / 459 (9.4%) |
| Working, 873 messages | live, LM Studio qwen2.5-7b on | 223 / 414 (**53.9%**) | 52 / 459 (**11.3%**) |
| Held-out, 421 messages, unread | rules only | 68 / 198 (**34.3%**) | 19 / 223 (**8.5%**) |

Before any label was corrected the working batch read 176 / 483 (36.4%) and 49 / 532 (9.2%); the corrections removed 142 rows, 130 of them by one blanket rule (qwen's Hindi and Vietnamese), and are listed in `relabel.mjs`. The held-out batch has had that blanket rule and no row-by-row review, so its figures still carry a little generator noise.

On the live path every message got a 200 and a reply, and every 911 reply came with exactly one RED alert (p50 11 ms, p95 22 ms with no model). With the model on: no non-200, no missing reply, p50 2.2 s, p95 7.7 s, slowest 14.1 s; the circuit breaker opened once in the run.

### After

Not measured, because nothing in the rules changed. Whoever fixes them: run `node docs/independent-eval/score.mjs evals/independent-2026-10-11-heldout.jsonl --quiet` (numbers only) and add both batches' rows here.

### By language

| Language | Working, rules: caught | false alarms | Working, model on: caught | false alarms | Held-out, rules: caught | false alarms |
|---|---|---|---|---|---|---|
| English | 100 / 220 (45.5%) | 23 / 251 (9.2%) | 133 / 220 (60.5%) | 27 / 251 (10.8%) | 43 / 112 (38.4%) | 9 / 126 (7.1%) |
| Spanish | 17 / 61 (27.9%) | 5 / 71 (7.0%) | 25 / 61 (41.0%) | 7 / 71 (9.9%) | 12 / 32 (37.5%) | 4 / 36 (11.1%) |
| Hindi (Gemini rows only) | 16 / 34 (47.1%) | 3 / 35 (8.6%) | 17 / 34 (50.0%) | 5 / 35 (14.3%) | 1 / 13 (7.7%) | 2 / 19 (10.5%) |
| Vietnamese (Gemini rows only) | 13 / 37 (35.1%) | 5 / 40 (12.5%) | 17 / 37 (45.9%) | 6 / 40 (15.0%) | 3 / 11 (27.3%) | 1 / 14 (7.1%) |
| Chinese | 23 / 62 (37.1%) | 7 / 62 (11.3%) | 31 / 62 (50.0%) | 7 / 62 (11.3%) | 9 / 30 (30.0%) | 3 / 28 (10.7%) |

The Hindi and Vietnamese held-out counts are small (13 and 11 emergencies); read them as "low", not as a percentage.

### By category

| Emergency category | Working, rules | Working, model on | Held-out, rules |
|---|---|---|---|
| chest pain or pressure | 42 / 53 (79%) | 49 / 53 (92%) | 17 / 24 (71%) |
| fainting or collapse | 35 / 50 (70%) | 41 / 50 (82%) | 16 / 26 (62%) |
| can't breathe at rest | 21 / 53 (40%) | 23 / 53 (43%) | 6 / 25 (24%) |
| relative unresponsive | 19 / 53 (36%) | 38 / 53 (72%) | 9 / 25 (36%) |
| coughing blood | 15 / 51 (29%) | 15 / 51 (29%) | 6 / 25 (24%) |
| sudden confusion | 14 / 52 (27%) | 24 / 52 (46%) | 5 / 22 (23%) |
| "I feel like I'm dying" | 13 / 50 (26%) | 21 / 50 (42%) | 5 / 26 (19%) |
| stroke signs | 10 / 52 (19%) | 12 / 52 (23%) | 4 / 25 (16%) |

| Calm category (false alarms) | Working, rules | Working, model on | Held-out, rules |
|---|---|---|---|
| all good | 0 / 53 | 0 / 53 | 0 / 24 |
| chit-chat | 0 / 50 | 0 / 50 | 0 / 23 |
| mild breathlessness after walking | 0 / 48 | 1 / 48 | 0 / 24 |
| mild swelling or weight gain | 0 / 51 | 0 / 51 | 0 / 26 |
| pain that is not in the chest | 1 / 47 (2%) | 2 / 47 (4%) | 0 / 26 |
| explicit "no chest pain or dizziness" | 4 / 53 (8%) | 5 / 53 (9%) | 3 / 23 (13%) |
| idioms | 5 / 54 (9%) | 8 / 54 (15%) | 3 / 24 (13%) |
| general questions | 5 / 51 (10%) | 5 / 51 (10%) | 2 / 27 (7%) |
| **past history** | **28 / 52 (54%)** | **31 / 52 (60%)** | **11 / 26 (42%)** |

### By who wrote the message, and by style (working batch, rules only)

| Written by | Caught | False alarms | | Style | Caught | False alarms |
|---|---|---|---|---|---|---|
| Gemini 3.8 Flash (English emergencies only) | 21 / 38 (55%) | n/a | | non-native or mixed language | 31 / 64 (48%) | 3 / 76 (4%) |
| Claude, by hand (English) | 20 / 37 (54%) | 6 / 39 (15%) | | voice-to-text run-on | 36 / 75 (48%) | 11 / 78 (14%) |
| qwen2.5-7b (en, es, zh) | 59 / 142 (42%) | 11 / 178 (6%) | | terse texting | 29 / 65 (45%) | 7 / 81 (9%) |
| Gemini Flash Lite (all five languages) | 69 / 197 (35%) | 26 / 242 (11%) | | caregiver, third person | 27 / 66 (41%) | 8 / 80 (10%) |
| | | | | worried ramble | 25 / 74 (34%) | 10 / 71 (14%) |
| | | | | older person with typos | 21 / 70 (30%) | 4 / 73 (5%) |

No source is easy: the best is 55%. The hand-written slice comes from the same model family as the rules' author and still scores 54%.

### What the model added

It never removed a catch. It caught 54 more emergencies than the rules on the same messages (33 English, 8 Spanish, 8 Chinese, 4 Vietnamese, 1 Hindi), mostly ones a person would describe rather than name: "his eyes are open right now but he won't talk to me or move at all", "I tried to wake him up just now but he won't budge", "head super foggy, no idea what's going on", a Spanglish "burning bien feo aquí en el middle del chest". It also raised 9 false alarms of its own, of the same kinds the rules already get wrong: "nearly had a heart attack", "casi me muero", "Before i went to hosptial last month i cold hardley breath at all. now its much better".

It did nothing for coughing blood (15 / 51 either way) and little for stroke signs and breathlessness at rest. The model's parse has fields for chest pain, breathing, fainting, confusion and "unresponsive" only, so it cannot report a stroke sign or coughed blood even when it understands the message.

## 2. Emergencies that are still missed, by kind

All examples are from the working batch (245 misses). These are the misses I could not fix, because the fix is in the rules.

| Kind | Examples |
|---|---|
| Breathless at rest, said without the listed nouns | "Been havin' a really hard time breathe in the chair over the last hour, and it keeps gettin' worse" · "I have been sitting here fighting for every breath since lunch" · "breathing is very struggle, air is not coming inside" · "My husband is resting in bed right now but he is so breathless he can barely get a single sentence out" |
| Third person and other verb forms (Spanish lists are first person) | "no puede respirar sentado en el couch, se siente como que se ahoga" · "Está ahogándose." · "Mi esposo está sentado ahorita sin hacer nada pero le falta mucho el aire" · "Mi papá se quedó totalmente flácido de repente, no responde cuando le hablamos" |
| Confusion described, not named | "Dad & mom didn't know who I was" · "he's been calling me by his brother's name and trying to put his shoes in the refrigerator" · "my head is so foggy right now cant think or tell whats going on around me" · "No piensa bien, cabeza nublada, no sabe q pasa." · "他刚才突然不记得这里到底是哪儿了也不知道今天是星期几" |
| Collapse and unresponsiveness in plain words | "i woke Up on the rug just now ... must of been out cold a minite" · "I lost consciousness a few minutes ago and came to on the carpet" · "Dad slumped in chair no reaction right now." · "i tried to wake him up just now but he wont budge pls help me" · "睁眼但不回应" |
| Stroke signs (19%) | "the left side of my face feels funy and droopy. my coffe is running out the side of my mouth" · "his right arm just dropped all limp and he cant push my hand" · "Sudden vision loss & can't talk properly." · "habla raro. no se entiende. ayuda ya" · "說話大舌頭惹" |
| Coughing blood (29%) | "Blood is coming out when I cough. I need help now." · "There is red in what I cough up into the tissue and it has happened several times in the last hour" · "I am coughing up blod.. bright red in the sink" · "mi abuelo esta tosiendo y le sale Sangre ahorita mismo" · "咳血" |
| "I'm dying" (26%) | "I feel I will die now. My body is finish." · "Thnk im dying rn" · "Terrified wont make it" · "My dad is telling us he ... feels like he is passing away right this second" · "me stoy muriendo ahorita. no aguanto." · "快不行了" |
| Hindi in Latin letters, Vietnamese without tone marks | "aj subh 2 baar behosh ho gye" · "Papa ko abhi khansi me blood aa rha hai right now" · "mummy ka chehra ek taraf se jhuk gaya hai" · "toi bi ho ra mau roi day ne" · "bo toi bay gio tu nhien ko nhan ra vo con la ai nua" |
| Even chest pain, when the word order is unusual or misspelled | "my heart place is pain very strong now, like stone is sitting on it" · "this terrible squezing start in my chedt maybe 15 min ago" · "ME ESTÁ DANDO DOLOR EN EL CORAZÓN" |

## 3. False alarms, by kind

43 in the working batch.

| Kind | Examples that got "call 911" |
|---|---|
| **Past history (28 of 52)** | "I used to get chest pain before my heart procedure and I have had none since" · "had chest pain before surgery. none since" · "my husband fainted once last spring before they adjusted his blood pressure medicine. It hasn't happened again" · "ONCE I FAINTED BUT IT WAS SO LONG AGO AND I AM GOOD NOW" · "cant breath last month. much better nw." · "hace años me dio un infarto pero ya estoy bien" · "我上次晕倒还是好久以前的事了" |
| Negation the rules do not read | "Dad says he doesn't have any pain in his chest and he isn't dizzy today either." · "Michael doesn’t feel any chest pain" · "I have not had any pain or pressure in my chest, I haven't been lightheaded" · "kg ngất lú thở bt" |
| Idioms | "nearly gave me a heart attack we laughed so hard I couldn't breathe" · "i thought i was going to faint when i saw the price" · "casi me ahogo de la risa" |
| "What if" questions | "what do we do if he gets that sharp chest pain or faints again even tho right now hes watching tv and feels alright" · "nếu mai có đau ngực hay ngất thì làm sao nhỉ" · "万一以后胸口痛或晕倒咋办现在没事问问" |

## 4. Bugs fixed (channels, my lane)

One commit each, with a test that failed before the fix.

| # | What happened | Fix | Test |
|---|---|---|---|
| 1 | A Telegram message **edited** into an emergency ("gracias" → "me duele mucho el pecho") got no reply and no alert; webhook mode did not even ask Telegram for edits | edits are read as new messages (not commands); `allowed_updates` includes `edited_message`, in polling too | `channels.edits.test.js` |
| 2 | The **caption** of a photo and the text of an MMS were dropped: "chest pain" under a picture got "thanks for the photo" | the words are read first, as their own message; an urgent reply stands alone | `channels.photo.test.js`, `webhooks.twilio.test.js` |
| 3 | A **Twilio retry** (same `MessageSid`) sent every reply a second time; a retried `JOIN DEMO` enrolled two patients | one delivery per `MessageSid`; a repeat gets the same TwiML | `webhooks.twilio.test.js` |
| 4 | A **video note, sticker, location or PDF** on Telegram got silence, left no trace, and during a RED lock did not repeat "call 911". A voice note that could not be transcribed was not logged and skipped the lock too | the core is told `[video note]` and so on, so the person gets an answer and the nurse sees it; an unheard voice note is logged, its reply carries the "call 911 if..." line, and the RED lock is honoured | `channels.unreadable.test.js` |
| 5 | The same on **SMS / WhatsApp**: an unheard voice note unlogged and outside the RED lock; a wordless message reached the core as an empty string | as above; `[attachment]` / `[no text]` | `webhooks.twilio.test.js` |
| 6 | A **rate-limited** Telegram chat (over 20 messages a minute) had its messages dropped unread and was told nothing | the first drop of a burst is answered with the "call 911 if..." line; one `rate_limited` audit row | `channels.resilience.test.js` |
| 7 | One **Withings** measure group with an impossible date made the whole delivery a 400 and lost its good measures | that group is rejected, the rest stored | `devices.withings.test.js` |

Tests changed on purpose (each pinned the old behaviour): three voice tests and one Twilio test expected the bare "please type" text; one photo test expected a PDF to be met with silence; one webhook test listed the old `allowed_updates`.

## 5. Bugs left open (other lanes; in `docs/team/REQUESTS.md`)

| # | Where | What happens | Test |
|---|---|---|---|
| 1 | `store.js` | Writes are held back 250 ms. `kill -9` the instant a 911 reply returns: after the restart the patient has no RED alert and no RED lock, though they were told "I have alerted your care team" | `independent.open.test.js` (todo), `edge.mjs` |
| 2 | `core/enroll.js` | `POST /api/patients` accepts `weights`, `prescriptions`, `meds` that are not lists; then `GET /api/patients` and every `/api/insights/*` answer 500 for everyone | todo test |
| 3 | `routes/api.js` | "Start check-in" and the social-needs screen ignore the RED lock: a patient told to call 911 gets "Are you having any of these right now?" | todo test, `fuzz.mjs` seeds 3, 4, 6 |
| 4 | `core/agent.js` | A caregiver's tap on an old "chest pain" button gets "Thanks! You're connected as a caregiver" and no alert (the contract says it is an emergency) | todo test |
| 5 | `core/checkin.js` | The 911 message says "I have also alerted your care team and your family" when there is no caregiver; "your family" is English inside every other language | todo test |
| 6 | `core/devicetriage.js` | `POST /api/devices/readings` with `ts: 1e308` is a 500 | todo test |
| 7 | `core/protocols.js` | `POST /api/alerts/:id/protocol { protocolId: "__proto__" }` on an eligible alert is a 500 | `api-probe.mjs` only |
| 8 | `test/checkin.hardening.test.js` | Two tests fail between midnight and 02:00 local time (and after 18:00), so `npm run check` is red at night; they pass with `TZ=UTC` | none needed |

## 6. What was exercised and held

- **Conversation fuzzer** (`fuzz.mjs`, seeds 1 to 6, about 11,600 patient messages, 1,600 nurse actions, 40 clock jumps, 715 RED locks entered): no 5xx or unexpected status from a patient message, a reply with text to every message, never a stuck check-in (plain answers always finished it), one message never finished two check-ins or raised two triage alerts, never two open RED alerts within an hour, the RED lock held against everything the patient and caregiver sent. The only violations were open bug 3.
- **Nurse-side sequences** ran alongside: acknowledge, contact, resolve with every outcome, reopen, bulk actions with unknown ids, standing-order applies, nurse messages with hostile text, check-in and screen starts, unlink. No 5xx.
- **Concurrency** (`edge.mjs`): a triple tap on the last question gives one check-in and one alert; patient, caregiver and a button tap reporting chest pain in the same instant give one RED alert and three 911 replies; ten patients finishing at once each end with their own weight; a nurse resolving a RED while the patient types.
- **Time**: a check-in answered across midnight finishes once with one weight; walking the clock in 12-hour steps across the US fall-back night, a New York and a Kolkata patient each get every check-in at 09:00 or 19:00 local, none twice, none missing.
- **Restart**: a check-in in progress resumes at the same question after `kill -9` (when the kill comes more than 250 ms after the last write), and the demo clock offset survives.
- **Security**: with `API_TOKEN` set, a missing or wrong token is refused on the seven routes tried (patients, simulate, demo reset, audit export, FHIR export, insights, device readings), a token in the query string is not accepted, and the three public routes stay open; a foreign `Origin`, `Origin: null`, a cross-site fetch without `Origin` and two look-alike origins are refused; a foreign `Host` is refused; a form post to a JSON route does nothing; bodies over the cap answer 413. Injection: an instruction to hide chest pain does not hide it, machine talk that forges a symptom raises nothing, zero-width characters do not hide the words.
- **API probe** (`api-probe.mjs`): about 1,100 wrong-typed requests across the routes. Apart from open bugs 2, 6 and 7, nothing answered 5xx. One mistake of mine: the first run included `POST /api/fhir/import`, so about 15 junk ids (no patient data) were looked up on the public HAPI sandbox. The script now leaves the EHR routes out and points `FHIR_BASE_URL` at a closed local port.
- **Dashboard** in Chrome against a throwaway backend: the empty worklist ("Nothing needs attention right now"); 110 open alerts render (all on one 41,000-pixel page, no paging), with patient-typed HTML shown as text; "Select routine alerts (100)" then "Acknowledge selected" sends two requests of 50, acknowledges all 100 and leaves the 10 RED alone; with the backend killed the list stays visible under "Live updates are paused (connection lost)", and it recovers without a reload.

## 7. Not covered, and limits of what is here

- **No rule was changed**, so recall is as bad after this work as before it. That is the main thing left.
- The set is written by models. It is harder and more varied than the author's own phrases, but it is not what patients send, the emergency categories are equally weighted rather than weighted as they occur, and nobody clinical decided that each "emergency" really is a 911 (the brief did).
- Hindi and Vietnamese rest on Gemini Flash Lite alone and on small numbers. No native speaker has read any non-English row, including the ones I judged while correcting labels.
- The hand-written slice is by the same model family as the rules' author.
- The model run used one small local model. A larger model would likely catch more; its parse still has no field for stroke signs or coughed blood.
- Not tested: real Telegram, Twilio, WhatsApp, Groq or Withings; the dashboard with a slow API, on a phone-width screen, or with a screen reader; several nurses on different machines; multi-day soaks in real time; the spring-forward change.
- The fuzzer talks to `POST /simulate`, so it does not exercise the Telegram or Twilio adapters; those were tested with the offline harnesses.

## 8. Reproducing

```bash
node docs/independent-eval/score.mjs evals/independent-2026-10-11.jsonl            # rules; lists every miss and false alarm
node docs/independent-eval/live.mjs  evals/independent-2026-10-11.jsonl            # live path, no model
node docs/independent-eval/live.mjs  evals/independent-2026-10-11.jsonl --llm=lmstudio   # about 40 minutes; add --every=3 for a third of it
node docs/independent-eval/score.mjs evals/independent-2026-10-11-heldout.jsonl --quiet
node docs/independent-eval/fuzz.mjs --seed=3 --patients=30 --rounds=12 --steps=6   # exits 1 until open bug 3 is fixed
node docs/independent-eval/edge.mjs                                                # 2 of 29 checks fail until open bug 1 is fixed
node docs/independent-eval/api-probe.mjs                                           # lists open bugs 2, 6, 7
```
