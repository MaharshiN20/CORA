# End-to-end walkthrough: patient (Telegram-style chat) and nurse website

**Date:** 2026-10-11 · **Primary language:** English (the other nine are shown as a capability, not the main path) · **Build:** `main` after commit `65cf7d4` + this walkthrough's fixes

Two kinds of testing, both against the real server on a throwaway database:

1. **By hand in Chrome** (website + the on-page phone simulator that stands in for Telegram).
2. **Scripted** (`docs/uat-2026-10-11/*.mjs`, run with `node docs/uat-2026-10-11/<file>.mjs`): 49 scenarios, 208 checks, plus 5 scenarios with a real local model.

| Suite | What it covers | Result |
|---|---|---|
| `patient.mjs` | check-in by taps and typing; weight formats and typos; every red-flag path; RED lock; calm talk that must not alarm; companion questions; dosing questions; chit-chat; blood pressure; photo; double-tap; stale buttons; hostile input; slash commands | 27 / 113 checks pass |
| `lifecycle.mjs` | scheduler and demo clock; silence ladder; medication reminders; refills; caregiver proxy, emergency and questions; alert lifecycle; bulk actions; nurse messages; standing-order card; digest, exports, analytics; SDOH; all four demo scenarios; kill -9 persistence; `API_TOKEN`; 40 patients at once | 20 / 87 |
| `journey.mjs` | 31 days on the demo clock for one patient (daily check-ins answered, drift raises a YELLOW, lessons, SDOH once, weekly digests, monitoring ends) | 1 / 8 |
| `english-model.mjs` | messy English with LM Studio on: natural answers, slang, emergencies and calm talk, questions, injection | 5 / 18 |

`npm run check`: 1,179 backend tests, 129 frontend tests, build green.

## Bugs found by this walkthrough (all fixed, each with a test)

| # | Where | What happened | Fix |
|---|---|---|---|
| 1 | Patient chat, in a check-in | Answering "slept in the recliner, **extra pillows**" raised a nurse "medication question" alert and replied "only your care team can change your medicines": `pill` matched `pillows` | word boundaries in the dosing rule |
| 2 | Website, nurse name box | The name was trimmed on every keystroke, so "Nurse Kim" could not be typed with a space (`NurseKim` went into the audit trail and the patient's "saw your update" message) | the box keeps what is typed, the stored name is trimmed |
| 3 | Phone simulator | `/help`, `/meds`, `/language`, `/voice`, `/checkin` only worked in real Telegram; on the website they got "Want to do your check-in?" | same commands now work in the simulator, including the language picker |
| 4 | Companion | "Will insurance pay for a taxi to the clinic?" was answered with the follow-up-visit text (matched on "clinic") | cost / insurance / travel / driving / surgery style questions go to the nurse |
| 5 | Companion | "Is it ok to have a bit of bacon with breakfast?" got an off-topic refusal | common salty foods added to the diet topic |
| 6 | Rules | "can't breathe **well** when I walk to the mailbox" raised 911; "scale says one sixty nine point eight" read as 169 | softened wording on exertion is "worse when walking" (a bare "can't breathe" is still 911, also after climbing stairs); decimal number words |
| 7 | Website, Join page | With no Telegram configured the "Scan to become a patient" page was a dead end | link to the in-browser phone simulator |
| 8 | Website, Demo page | The phone simulator opened on the Spanish-speaking patient | opens on an English-speaking patient |

## Verified by hand in the browser

- Worklist: RED banner and tab-title count, live updates from the demo scenarios, acknowledge / contacted / resolve with outcome (a "false alarm" on a RED returned the patient to GREEN), assignee, bulk select + "assign selected to me", search by reason, filters present, projector mode, desktop-alert toast, standing-order card (eligibility checks, 2-second undo window, FHIR preview, patient notified, follow-up task created), message-a-patient with delivery status ("logged in the chat; patient not on Telegram/SMS yet"), EHR import dialog with the public-sandbox warning.
- Patient page: risk explanation, weight chart, timeline, "How it decided" evidence list, Spanish conversation with the English line for the nurse, simulator typing and buttons.
- Demo console: the four scenarios play at human pace; clock +6h / +1 day / +3 days / reset.
- Impact page and lazy-loaded routes render with no console errors.
- Outage: stopping the backend shows "Can't reach the server. Retrying..." plus a Retry button; restarting it recovers without a click and the data is intact.
- 404s: unknown patient and unknown route have friendly pages.

## Things that are fine but worth knowing

- With **no model**, a Vietnamese/Hindi patient's message reaches the nurse untranslated (no English line). Emergency handling still works (rules), but the nurse reads the original. Not an issue for the English-first plan; a model is needed for the English line.
- The in-browser phone cannot send real Telegram features (typing indicator, inline-keyboard locking after a tap).
- The 16 s the demo scenarios take are deliberate pacing (`?fast=1` skips them).

## Not covered (be honest in the pitch)

- **Mobile layout and screen readers:** the browser tool could not shrink the viewport, so the narrow layout was not seen. The desktop layout is solid.
- Real Telegram, Twilio, WhatsApp, Groq voice and Withings scales; voice notes and photos with real media; vision-model scale reading.
- Live EHR search against the public HAPI server (deliberately not called with test names).
- Time-zone behaviour with a real patient abroad (unit-tested only), multi-day soak with real time, several nurses at once on different machines.
- Clinical review of thresholds and wording; native-speaker review of the non-English text.
