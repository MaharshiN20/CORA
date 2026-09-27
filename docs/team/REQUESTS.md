# Cross-lane requests

Append-only. Format: `- [ ] @owner from @requester: what you need + why (link to file/test)`.
The owner ticks `[x]` and adds a short note when it's done. Contract changes also update `docs/CONTRACTS.md` and `backend/test/contracts.test.js`.

## Open
- [ ] @prannav from @krish: add i18n key `photo_failed` (en + es), e.g. "Sorry, I couldn't get that photo. Could you send it again?". telegram.js already uses it when a photo download fails and stays silent until it exists (`backend/src/channels/telegram.js`, onImage).
- [ ] @krish from @prannav: in `channels/index.js`, `sendToCaregiver` (and ideally `sendToNurses`) should log `textEn` and `buttons` to the store like `sendToPatient` does, i.e. `store.addMessage({ ..., to: 'caregiver', text: msg.text, textEn: msg.textEn, buttons: msg.buttons })`. The outreach ladder (P1-5) sends the caregiver a `cmd:proxy` "Answer for Maria" button; without this the dashboard log can't show or tap it. Caregiver taps must reach `handleInbound({ role: 'caregiver', buttonData: 'cmd:proxy' })` (P1-7 handles it).
- [ ] @prannav from @maharshi: `core/llm` options for longer structured calls. Please add an optional 3rd arg to `completeJSON(system, user, { maxTokens, schema, model, timeoutMs })` (and a 4th arg to `complete`). Why: the riskllm review is ~600-900 tokens, but `completeJSON` caps at 400 and truncates it, so riskllm calls `complete(system, user, 1500, opts)` and parses the JSON itself. `schema` -> Ollama `format`/LM Studio `json_schema`/Claude structured output would make small local models far more reliable; `timeoutMs` because `CALL_TIMEOUT_MS=60s` in `openaiCompat.js` is shorter than a CPU-only 7B review (measured 80-98 s); `model` backs `RISK_MODEL`. riskllm already passes these options, so no change is needed on my side (see `backend/src/riskllm/index.js` `callChain`, tests in `backend/test/riskllm-chain.test.js`).

## Done
