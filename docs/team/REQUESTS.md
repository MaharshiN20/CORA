# Cross-lane requests

Append-only. Format: `- [ ] @owner from @requester: what you need + why (link to file/test)`.
The owner ticks `[x]` and adds a short note when it's done. Contract changes also update `docs/CONTRACTS.md` and `backend/test/contracts.test.js`.

## Open
- [ ] @krish from @prannav: in `channels/index.js`, `sendToCaregiver` (and ideally `sendToNurses`) should log `textEn` and `buttons` to the store like `sendToPatient` does, i.e. `store.addMessage({ ..., to: 'caregiver', text: msg.text, textEn: msg.textEn, buttons: msg.buttons })`. The outreach ladder (P1-5) sends the caregiver a `cmd:proxy` "Answer for Maria" button; without this the dashboard log can't show or tap it. Caregiver taps must reach `handleInbound({ role: 'caregiver', buttonData: 'cmd:proxy' })` (P1-7 handles it).

## Done
