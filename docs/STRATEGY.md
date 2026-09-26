# HeartBridge Strategy

Read this before building anything. It's the shared thesis, demo plan and ownership for the team.
Track: **Social Good (Healthcare, Sustainability)**. Horizon: ~3 months to the first strong MVP.

## 1. The problem, and why it's worth solving

| Fact | Source |
|---|---|
| About 1 in 5 heart-failure patients is readmitted within 30 days (20.5%, down from 24.8%) | [JACC: Heart Failure HRRP position paper](https://www.sciencedirect.com/science/article/pii/S2213177919306754) |
| HF is one of the 6 conditions CMS penalizes (AMI, HF, pneumonia, COPD, CABG, hip/knee) | [CMS HRRP](https://www.cms.gov/medicare/quality/value-based-programs/hospital-readmissions) |
| FY2026: ~2,545 hospitals (75%) penalized. Median 0.69% of Medicare inpatient pay, max 3%, ~240 hospitals at ≥1% | [Healthsignal FY2026](https://healthsignal.contact/learn/hrrp-penalties-2026) |
| Low adherence, prescription discrepancies and limited health literacy are each independently tied to rehospitalization | [PubMed 42452690](https://pubmed.ncbi.nlm.nih.gov/42452690/) |
| >42% of 60M multilingual Americans have limited English proficiency, and linguistically diverse HF patients have more readmissions | [JACC HF: LEP patients](https://www.sciencedirect.com/science/article/pii/S2213177922001834) |
| Post-discharge contact is billable: TCM 99495 ~$220 / 99496 ~$298, RPM 99454 ~$52/mo, 99457 ~$52 per 20 min, and these can stack | [ThoroughCare TCM 2026](https://www.thoroughcare.net/blog/2026-transitional-care-management-cpt-codes), [RPM 2026](https://www.thoroughcare.net/blog/remote-patient-monitoring-billing-rules) |

### The main finding: monitoring fails because patients stop engaging
Big telemonitoring trials (Tele-HF, BEAT-HF) showed **no readmission benefit**, mainly because patients stopped using the system. Programs with high engagement show large effects ([TIM-HF2](https://www.thelancet.com/journals/landig/article/PIIS2589-7500(19)30195-5/fulltext); text programs where engaged patients had [7.7% vs 24% readmission](https://pmc.ncbi.nlm.nih.gov/articles/PMC11437225/)). Monitoring works when patients keep responding and nurses act on a small number of well-targeted alerts.

### Our thesis
> Remote monitoring fails when patients stop answering and nurses get flooded with alerts. HeartBridge addresses both. It reaches patients **in their language, on messaging apps they already use, with their family involved**, and it **escalates only what matters**, with a reason attached to every alert.

### Hard questions judges will ask, and our answers
| Question | Answer |
|---|---|
| "Isn't this just a chatbot?" | The LLM only handles language. Triage is deterministic, cites guidelines, and every alert comes with its reasons. A nurse closes the loop, and silence is escalated too. |
| "Companies already do this" (HRS, Biofourmis, Cadence, Memora) | They rely on tablets, devices or apps and are English-first. We need no install, work in any language, involve the family, and cost very little. |
| "Telegram isn't HIPAA-compliant" | Correct. It's our dev/demo channel. Channels are pluggable, and production uses SMS/WhatsApp through BAA vendors. **Local LLMs (Ollama/LM Studio) keep patient data on hospital hardware.** |
| "What if the AI is wrong?" | It never decides severity. Rules do, and they're unit-tested (40 tests) and logged. |
| "Who pays?" | Hospitals: avoided HRRP penalties plus TCM/RPM billing. Free or sliding-scale for safety-net hospitals. |

## 2. How we win the Social Good track
**Story:** Maria is 78, speaks Spanish, lives alone, has limited health literacy, and her daughter works double shifts. She's discharged Tuesday. By Friday she's up 3 lb and sleeping on 3 pillows. Today an ambulance comes on Sunday. With HeartBridge, a nurse calls her Friday afternoon.

**Demo moments** (build toward these):
1. **Judges become patients**: scan a QR code, get enrolled on their own phone, run a check-in, and the alert appears live on the projected dashboard.
2. **Language switch**: the same flow in Vietnamese through a local LLM, with English shown to the nurse.
3. **Silence is a symptom**: advance the clock, Maria doesn't answer, she gets a nudge, then her daughter is pinged, then the nurse worklist shows it.
4. **Spanish voice note** → transcribed → triaged.
5. **Discharge companion**: "¿Puedo comer sopa de lata?" gets an answer grounded in her own discharge instructions.
6. **Impact panel**: engagement, alerts per nurse, readmissions avoided, $ saved and billed.

**Credibility:** have a clinician review the triage rules, publish parser accuracy per LLM provider from an eval set, and write a one-page safety & privacy doc.

## 3. Architecture principles
- **The LLM handles language; rules decide.** No clinical decision depends on a model.
- **Degrade gracefully**: no LLM → rules, no Telegram → dashboard simulator, no device → self-report.
- **Stable contracts between owners**: `handleInbound` / `sendToChat` (channels), `scoreRisk(p) → {score, tier, factors, plan}` (risk), and the condition-pack interface (coming soon).
- **Audit everything**: each triage decision logs its inputs, the rules that fired and the resulting action.
- **LLM chain**: Claude → Ollama → LM Studio → rules, picked automatically (`backend/src/core/llm/`).

## 4. Roadmap
**Weeks 1–4: close the care loop.** LLM chain ✅, scheduler + demo clock, medication reminders + adherence, pharmacy refill-gap detection, escalation for non-responders, nurse workflow (ack → contacted → resolved + outcome), caregiver loop (alerts, weekly digest, proxy check-in), judge QR mode.

**Weeks 5–7: equity & access.** Discharge companion Q&A (grounded, guardrailed), verified templates for top languages, voice in/out, teach-back micro-lessons, social-needs check (rides, med costs, food → resources), SMS + WhatsApp adapters.

**Weeks 8–10: credibility & expansion.** Condition packs (CHF → COPD → post-surgical with wound photos), device data (Withings), FHIR import from the Epic/SMART sandbox, eval harness, impact analytics computed from real data.

**Weeks 11–12: polish.** Seeded scenarios, demo script, failure drills, deck, video, Devpost.

**Out of scope for MVP:** real PHI, production HIPAA infrastructure, EHR write-back, payer integrations.

## 5. Expansion (roadmap slide)
- **Conditions**: all 6 HRRP conditions through packs, then diabetes, post-partum hypertension (maternal equity) and oncology symptoms.
- **Settings**: skilled-nursing-to-home transitions, ED discharges, Medicare Advantage plans, FQHCs and safety-net hospitals.
- **Channels**: SMS, WhatsApp, IVR phone calls for flip phones, smart speakers.

## 6. Ownership
| Owner | Scope |
|---|---|
| Prannav + Claude | core engine, LLM chain, scheduler/meds/pharmacy/outreach, companion, condition packs, integrations, evals |
| Telegram teammate | `backend/src/channels/*`: Telegram UX, judge enrollment, voice, then SMS/WhatsApp |
| Risk teammate | `backend/src/core/risk.js` (keep the `scoreRisk` contract), risk validation, impact/ROI analytics |
| 4th / shared | dashboard UX, pitch deck, demo video, clinician outreach |
