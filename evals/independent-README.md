# Independent red-flag set (2026-10-11)

`messages.jsonl` and the audit phrases were written by the same author as the rules, so "0 missed emergencies" there only says the rules pass the cases their author thought of. These two files were written by someone else, without looking at the rules.

| File | Rows | Scored | What it is |
|---|---|---|---|
| `independent-2026-10-11.jsonl` | 1,015 | 873 (414 emergencies, 459 calm) | the **working batch**: read, corrected by hand, and the one fixes may be tuned against |
| `independent-2026-10-11-heldout.jsonl` | 495 | 421 (198 emergencies, 223 calm) | the **held-out batch**: nobody has read it. Score it with `--quiet` (numbers only) and open it only after the rule fixes are done |

Scored rows per language: working batch en 471, es 132, zh 124, vi 77, hi 69; held-out en 238, es 68, zh 58, hi 32, vi 25.

Row shape: `{ id, lang, label, category, style, source, text }`, plus `was` and `why` on a row that was taken out (`label: "exclude"`).

## Who wrote it
| Source | Rows (both batches) | Notes |
|---|---|---|
| Gemini (`gemini-flash-lite-latest`, and `gemini-3.8-flash` for the first 54 English rows) | 694 | through the team's `GEMINI_API_KEY`; prompts carried no patient data |
| `qwen2.5-7b-instruct` on LM Studio (local) | 714 written, 498 scored | its Hindi and Vietnamese are excluded, see below |
| Krish's Claude (`claude-opus-5-5`), by hand | 102 | English only, one per category and style, written **before** opening `core/parser.js`, `core/redflags-intl.js` or `core/redflags-more.js`. Same model family as the rules' author, so this slice is the least independent; the report scores every source separately |

No human wrote or reviewed a row. No native speaker and no clinician has checked the Spanish, Vietnamese, Hindi or Chinese. Model-written text is not the same as what patients type; treat the numbers as a much harder test than `messages.jsonl`, not as field data.

## How the generators were asked
`docs/independent-eval/spec.mjs` holds every prompt. A generator is told the **situation** (for example "the patient was woken a few minutes ago by a strong ache or tightness in the chest, and it is still there"), who is writing and how, and the language. It never sees a keyword list, an example message, the label, or another category.

- **Emergencies** (label `emergency`, the right answer is "call 911 now"), eight categories with four circumstances each: `chest` (pain or pressure), `breath_rest` (cannot breathe at rest), `faint` (fainting or collapse), `confusion` (sudden), `unresponsive` (a family member reporting it), `stroke` (face, speech, one-sided weakness, vision), `hemoptysis` (coughing blood or pink froth), `dying` ("I feel like I'm dying").
- **Must not trigger 911** (label `calm`), nine categories: `all_good`, `negation` ("no chest pain or dizziness"), `exertion` (mild breathlessness after walking that settles), `question` (general, and "what should I do IF..."), `history` (a heart attack years ago, fainted once long ago), `idiom` ("this heat is killing me"), `other_pain` (knee, back, tooth), `chitchat`, `mild_swelling` (slightly puffy ankles, one pound up).
- **Six styles**: an older person with typos, voice-to-text run-on, terse texting, a worried ramble that buries the key fact, non-native or mixed language (Spanglish, Hinglish, Vietnamese without tone marks, Traditional Chinese), a caregiver in the third person.

The labels follow the brief for this set (stroke signs, coughing blood, "I feel like I'm dying" and an unresponsive relative are 911). A calm row that fires is a false alarm even when it would only have meant a nurse call.

## Cleaning and labels
1. `build.mjs` drops exact duplicates and rows in the wrong language (20 rows, mostly Chinese requested and English written) and splits every (language, category) group two to one with a fixed seed.
2. Every row is labelled by the situation that was requested.
3. Every working-batch row where the rules and the label disagreed (356 of 1,015) was read, and later the 11 calm rows that only the model fired on. A row is taken out only when the generator did not write what it was asked for; a real miss or a real false alarm is never relabelled. `relabel.mjs` records each one with the reason:
   - **blanket rule** (both batches, applied to the held-out batch without reading it): qwen2.5-7b cannot write Hindi (word salad) and a third of its Vietnamese that was read was unreadable or drifted into Chinese, so all 204 of its rows in those two languages are out. Hindi and Vietnamese are scored on Gemini's rows only. Gemini wrote most of its Hindi in Latin letters, which is how many people type it;
   - **12 single rows** in the working batch (for example "¿Ya voy?", which says nothing about the situation, or a "negation" row that reports chest tightness today).
4. The held-out batch has had the blanket rule and nothing else. Its numbers therefore still carry a little generator noise (in the working batch the single-row corrections were 12 of 367 rows read).

## Running it
```bash
node docs/independent-eval/score.mjs evals/independent-2026-10-11.jsonl                  # rules only, lists every miss and false alarm
node docs/independent-eval/live.mjs  evals/independent-2026-10-11.jsonl                  # real server, POST /simulate, LLM_PROVIDER=none
node docs/independent-eval/live.mjs  evals/independent-2026-10-11.jsonl --llm=lmstudio --every=3   # with a local model (about 15 s a message)
node docs/independent-eval/score.mjs evals/independent-2026-10-11-heldout.jsonl --quiet  # held-out: numbers only
```
`--backend=<path>` scores another checkout (a git worktree of an older commit) for before/after comparisons. Results and what they mean: `docs/independent-eval/REPORT.md`.

To regenerate (new wording, same recipe): `generate.mjs --provider=lmstudio|gemini --out=<file>`, then `build.mjs <raw files> --date=<date>`, then `relabel.mjs`.

## Rules for using it
- Do not read the held-out file while changing the rules. After a round of fixes, score it with `--quiet`; if you then need to read its misses, write a new held-out batch first.
- Do not add one phrase per miss. The working batch is 873 wordings out of an endless number; a fix that only makes these rows pass says nothing about the next 873.
