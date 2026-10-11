# Findings ledger (raw, in order found)

## Env
- LM Studio: qwen2.5-7b-instruct, ~35 tok/s generation, ~500 tok/s prompt eval, ~2 s fixed overhead on tiny calls.
- HEAD 57a3171, suite 922 backend / 127 frontend green, CI green on e0e4e48.

## F-RULES (t_rules.mjs; 97 phrasings; 70 right, 27 wrong)
MISSED EMERGENCIES (rules only, LLM not consulted for en/es unprompted):
- "feels like an elephant is sitting on my chest"
- "there is a crushing pain in the middle of my chest"   (symptom word >4 words from "chest")
- "I feel like I am suffocating"
- "I keep blacking out" / "everything went black and I hit the floor"
- "dad is not making sense and keeps asking where he is"
- "chest feels like its on fire"
- "I am so short of breath I cannot finish a sentence"
- typos: "cant brethe", "chest paiin", "faintd", "chestpain" (no space)
- "chest...pain" (ellipsis splits clause)
- "no pain in my legs but my chest is killing me"  (negation 'no' leaks over 'but'? actually 'killing me' not a CHEST_BAD word)
FALSE RED (calm text -> 911 + RED alert + 1h RED lock):
- "I had chest pain last year but today I feel great"
- "what should I do if I have chest pain?"  /  "is chest pain normal after discharge?"
- "the pharmacist said it might cause chest pain as a side effect"
UNICODE: no NFKC / zero-width strip: ZWSP inside word, soft hyphen, full-width, Cyrillic homoglyph, newline between words, "cheeeest", "ch3st", "c.h.e.s.t" all evade.
ReDoS: none. 100KB worst case 32 ms.

## F-API fuzz (1309 requests, t_fuzz.mjs) and CSRF (t_csrf.mjs)
- 500s: POST /patients/:id/simulate with non-string `text` (e.g. true) -> 500 "internal error" (20 variants).
- 500 + LEAK: POST /patients/:id/message with non-string `text` -> 500 {"error":"text?.trim is not a function"} (23 variants). Route returns err.message with err.status ?? 500.
- 2 MB text body to simulate accepted (200): limit is 10 MB for the photo route, applies to text; would be fed to LLM prompts.
- JSON endpoints accept application/x-www-form-urlencoded (global urlencoded parser meant for Twilio) -> CSRF.
- With NO API_TOKEN (the default) a cross-site HTML form (no preflight) successfully: created a patient, faked patient message via simulate, unlinked a patient, sent a nurse->patient message ("Stop taking your meds", language es), started a check-in, advanced the demo clock 720h (ran 61 jobs), WIPED the DB via /api/reset, regenerated cohort.
- Dev CORS reflects any Origin (allow-origin: https://evil.example) -> a web page can READ /api/patients.
- Host header not validated (DNS rebinding works).
- With API_TOKEN set: all 401. text/plain JSON trick -> 400 (good).
- No query/path param 500s; no prototype pollution; latency fine (p50 1 ms, p95 3 ms).

## F-EVAL language eval with qwen2.5-7b-instruct (248 rows; evals output at $TEMP/lang-eval.md)
- rules: P96 R72 red-flag 93/93 FP 0/155. model alone: P88 R62 red-flag 64/93 (69%) FP 2/155, p50 970 ms p95 1.5 s. hybrid: P97 R82 red-flag 93/93.
- Model alone MISSES basics: "cant breathe", "I can't catch my breath", "no puedo respirar", "tôi không thở được", "我无法呼吸", "दम घुट रहा है"; en red-flag recall 69%.
- BUT the rules' 100% is in-sample: same author wrote rows and patterns. On 97 fresh phrasings (t_rules) the same rules got 27 wrong (14 misses of 50 real emergencies = 72% recall on fresh real phrasings). Compare the "100%" headline.
- diureticTaken recall 22% rules / 6% model / 28% hybrid.

## F-COMPANION A/B (35 questions, fresh patient each; t_companion_ab.mjs)
- WITH MODEL: 0 real answers. 19 OFF-TOPIC-REFUSAL ("I can help with questions about your heart..."), 6 'other' (es/vi), 9 dosing/nurse, 1 check-in. Flagship demo question "¿Puedo comer sopa de lata?" -> refusal. Also "How much water can I drink", "Can I take Tylenol?", "How do I weigh myself", "wine", "salt substitute", "exercise", "follow-up appointment".
- RULES-ONLY (no model): 20 real answers (canned soup, water, ibuprofen, weigh, exercise...). So ENABLING the LLM REGRESSES the companion. Cause: LLM category 'other' for in-scope questions + `if (!llm.enabled())` guards the keyword path, so no fallback.
- Rules-only wrong answers: "glass of wine" -> fluid-limit section (keyword 'drink'); "pacemaker vs pills" -> medicine list; "side effects of carvedilol" -> medicine list for other drugs (Torsemide...); "exact dose of metoprolol" -> greeting "Want to do your check-in now?" (DOSING_CHANGE misses "exact dose of"); "capital of France" -> creates a nurse task (noise); vi: every question -> nurse task (keywords en/es only).
- Mid check-in questions: once a symptom-ish question started a check-in ("I feel dizzy when I stand up, what should I do?" -> CHECKIN-STARTED), every later question was answered "Sorry, I didn't quite catch that" (no companion while a check-in is open; check-in persists up to 6 h).
- "What should I do when I feel short of breath walking?" starts a check-in instead of answering.
- (retracted) seed is GREEN; the RED state came from the false 911 of S3.
- Chinese free-text "没有胸痛，也没有晕倒" (no chest pain, no fainting) never advances the red-flag step (check-in stays at 'redflags' for 4 messages); only buttons advance non-en/es. (to re-verify with fresh vi/hi/zh patients)
- Unprompted en/es phrases NOT escalated while mid-check-in: "se me va a salir el corazón del pecho...", "mi esposo se cayó y no responde", "siento que me muero" -> "Perdón, no entendí bien" (to re-verify idle).
