# Demo script (3 minutes)

The live path never waits on an AI provider: every beat below is a scripted scenario or a
button, and each one plays the same with or without an LLM. Free-text chat is a bonus.

## Before you go on stage (2 min)
1. `npm run dev`, open `http://localhost:5173`.
2. **Demo → Reset demo.** This reseeds all five patients and resets the demo clock.
3. Worklist should be empty ("Nothing needs attention right now"). Every patient shows 0 missed check-ins.
4. Tick **Projector mode** in the header if you're on a projector (checked at 1280×720).
5. Optional: open a second tab on the Demo page for the phone simulator.

## The pitch, click by click

| Time | Say | Click |
|---|---|---|
| 0:00 | "Heart-failure patients go home with a scale and a pamphlet. A quarter are back within 30 days, and the warning signs show up days earlier, at home, in their own language." | Worklist (empty) |
| 0:20 | "Maria speaks Spanish. Her daily check-in is on Telegram, but here's the same chat in the simulator." | **Demo → 🟡 Maria (Spanish)**. The simulator plays her answers: 179 lb, "los tobillos están más hinchados", worse when walking. |
| 0:50 | "Rules, not the AI, decided that: +4.9 lb in a day, +7 in a week, worse swelling. YELLOW, and her daughter got a plain-English update." | **Worklist**: Maria's card shows a vitals strip, sparkline and phone number. |
| 1:10 | "Here's the part nurses love: the clinic's standing order. Every eligibility check comes from her chart: no red flags, took today's pill, labs from 6 days ago are in range. The dose comes from the clinic's protocol file, never from AI." | **Apply protocol & notify patient** → the 5 s Undo window → applied: Spanish instructions sent, re-weigh task at 08:00, FHIR MedicationRequest preview. |
| 1:40 | "Now an emergency. Thanh speaks Vietnamese." | **Demo → 🔴 Thanh**. He taps "Fainted" on the first question → 911 now, son Minh alerted, RED banner + toast on the Worklist. |
| 2:00 | "He says he feels fine now. The bot doesn't move on: the RED lock repeats 911 for an hour, and his message lands on the same RED card." | Worklist: the RED card shows "Patient messaged again at …". |
| 2:15 | "How do we know the AI isn't deciding? Press D." | On a patient page press **D**: raw message → AI extraction with quoted evidence (and anything the validator threw out) → rules fired → tier. |
| 2:35 | "Silence is a signal too." | **Demo → 📵 Anil**: no reply → +2 h reminder → +6 h his granddaughter is asked to check in. Anil's page shows the countdown to the next rung. |
| 2:50 | "Impact: engaged patients readmit at a third of the rate in our synthetic cohort (it's labelled illustrative, and it's correlational). Every alert closes the loop back to the EHR." | **Impact**, then **Export to EHR** on any patient page. |

## If something breaks
- **Backend restarted or Wi-Fi blipped:** the red "can't reach the server" banner shows, and the page recovers on its own within 10 s. No reload needed.
- **AI provider slow or out of quota:** nothing in the path above needs it. Free-text parsing gives up after 4 s and falls back to the rules and buttons.
- **A scenario looks half-played:** click it again. Each run resets that patient first.
- **Anything else:** Demo → Reset demo, then replay the scenarios. Each one takes about 10 s.

## What to say if a clinician asks
- *Who decides the tier?* Deterministic rules (`core/triage.js`). The LLM only parses and translates. Every value it extracts must quote the patient's words, and numbers must match the quote. The one exception is the AI reviewer: it can only *raise* GREEN → YELLOW for nurse review.
- *What if the patient says "no" to the pillows question?* "My usual 2 pillows" is baseline. Only more pillows, sleeping propped up or in a recliner count as orthopnea. Waking up breathless (PND) is its own answer.
- *Is the standing order real medical advice?* No. HF-02 is a clearly labelled demo file. A clinic authors and signs its own protocol, and the nurse is the one who clicks.
