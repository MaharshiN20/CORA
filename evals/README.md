# Language-layer evals

Evidence for "the LLM handles language, rules decide": how reliably do the offline rules
and each LLM provider turn a patient's message into check-in answers, in five languages?

```bash
cd backend
npm run eval                          # rules + every available provider (Claude / Ollama / LM Studio)
npm run eval -- --no-llm              # rules only: offline, milliseconds
npm run eval -- --providers=ollama    # pick providers; OLLAMA_MODEL=qwen2.5:7b to pin a model
```

It writes [`RESULTS.md`](RESULTS.md) and exits 1 if the red-flag gate fails.

## Files
| File | What |
|---|---|
| `messages.jsonl` | 156 labelled messages (en 51, es 45, vi 20, hi 20, zh 20): `{ id, lang, step, text, expected, note? }`. `expected` is what the message actually says, not what a parser happens to catch. Hard cases are tagged in `note`: negations, typos, units (kg / kilos / 公斤 / किलो / ký), run-ons, sarcasm, emergencies hidden in chit-chat. |
| `score.js` | Pure scoring: normalization, a rules predictor that mirrors `core/checkin.js`, the live hybrid, precision/recall, red-flag recall, the gate, the report. Tested in `backend/test/insights-evals.test.js`. |
| `run.js` | CLI: runs each provider pinned with `LLM_PROVIDER`, writes `RESULTS.md`. |

## How to read it
- **rules**: `parseWeight` / `parseSpo2` / yes-no at their step, plus `parseFreeText`, exactly as a check-in applies them.
- **\<provider\>**: `parseWithLLM` alone, with no step context.
- **hybrid:\<provider\>**: the live system. Inside a check-in, rules first and the LLM only if the rules understood nothing. For unprompted messages (`step: free`), rules only, because that's what `handleUrgentFreeText` does today.
- **Red-flag recall**: of the messages that mean "call 911" (chest pain, confusion, fainting, breathless at rest, SpO2 < 90), how many were caught. **False alarms**: non-emergency messages that would be escalated anyway.
- LLM numbers move a little between runs (sampling temperature 0.2); rules numbers don't.

## Findings (2026-09-27, qwen2.5:7b on Ollama, RTX 4070)
1. **Gate fails: rules miss 7 English/Spanish emergencies.** "short of breath even sitting on the couch", "my chest has been really tight", "cant breath", "chest pian", "me falta el aire incluso descansando", "me duele mucho el pecho", "tengo el pecho apretado". Filed for the parser owner in `docs/team/REQUESTS.md`.
2. **Unprompted non-English emergencies are missed in the live flow.** Outside a check-in only the rules run, so Vietnamese / Hindi / Chinese messages like "Mẹ tôi có vẻ lú lẫn…" (confusion) and "tức ngực…" (chest tightness) never escalate, even though the LLM alone catches most of them. Filed: run `parseWithLLM` in `handleUrgentFreeText` when the rules find nothing (rules still decide the tier from the parsed flags).
3. **Rules raise false alarms on negations and orthopnea.** "no chest pain", "sin dolor de pecho", "no fainting, no confusion", "can't breathe when I lie down" (orthopnea, not breathlessness at rest). Over-triage is the safe direction, but each one is a 911 instruction and a RED alert.
4. **The hybrid is the right design.** Inside check-ins it lifts recall from 52% (rules) to ~74%, catches every vi/hi/zh check-in emergency the rules miss, and keeps rules-level precision. Local 7B latency is ~0.25 s p50 on a GPU.
