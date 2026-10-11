// Hand corrections to the generated labels, applied in place to the committed batches (idempotent).
//   node docs/independent-eval/relabel.mjs
// A row keeps its text and gets label 'exclude' plus `was` (the generator's label) and `why`.
// Excluded rows are not scored. Two kinds of correction:
//  1. A blanket rule, decided on the working batch and applied to both batches without reading the
//     held-out one: qwen2.5-7b cannot write Hindi (word salad) and about a third of its Vietnamese
//     rows that were read were unreadable or drifted into Chinese, so its rows in those two languages
//     are out. Hindi and Vietnamese are therefore scored on the Gemini rows only.
//  2. Single rows, each read by hand because the rules and the label disagreed on it. Only rows
//     where the generator did not write the situation it was asked for are changed; a real miss or
//     a real false alarm is never "fixed" here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILES = ['evals/independent-2026-10-11.jsonl', 'evals/independent-2026-10-11-heldout.jsonl'];

const BLANKET = (r) => (/^qwen/.test(r.source) && (r.lang === 'hi' || r.lang === 'vi') ? 'qwen2.5-7b cannot write this language reliably (blanket rule, both batches)' : null);

const ROWS = {
  // working batch, read 2026-10-11 against the rules before any fix
  'ia-en-126': 'says the odd talk is "nothing new today": not a sudden change',
  'ia-en-159': 'drifted to "weak and dizzy", never says they feel they are dying',
  'ia-en-207': 'a word-for-word Spanish sentence in the English set',
  'ia-en-231': 'red on a tissue with no cough, "nothing too serious": not clearly coughing blood',
  'ia-es-048': '"¿Ya voy?" says nothing about the situation',
  'ia-es-059': 'never says what happened twice',
  'ia-es-125': 'drooping noticed days ago and already seen by a doctor: not happening now',
  'ia-zh-032': '"lately keeps mixing up places and times": not sudden, not clearly now',
  'ia-zh-035': '"lately talks in a jumble": not sudden, not clearly now',
  'ia-zh-093': 'asked for a denial, reports chest tightness today: neither calm nor a clear emergency',
  // working batch, read after the run with a model on (the model fired on them, the rules did not)
  'ia-en-176': 'asked for mild breathlessness after walking, wrote chest tightness on exertion: neither calm nor a clear emergency',
  'ia-es-094': 'garbled: "a bit tight" with no word for what is tight',
};

for (const rel of FILES) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  let changed = 0;
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((r) => {
    const why = ROWS[r.id] ?? BLANKET(r);
    if (!why || r.label === 'exclude') return r;
    changed++;
    return { ...r, label: 'exclude', was: r.label, why };
  });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const left = rows.filter((r) => r.label !== 'exclude');
  console.log(`${rel}: ${changed} newly excluded, ${rows.length - left.length} excluded in all, ${left.length} scored (${left.filter((r) => r.label === 'emergency').length} emergencies, ${left.filter((r) => r.label === 'calm').length} calm)`);
}
