// Turns the raw generator output into the two committed batches.
//   node docs/independent-eval/build.mjs <raw-a.jsonl> <raw-b.jsonl> ... [--date=2026-10-10]
// Cleans (empty / duplicate / wrong-script rows out), then splits every (language, category) group
// two-to-one with a fixed seed: two thirds become the working batch, one third the held-out batch.
// It prints counts only, never a held-out message: that batch stays unread until the final scoring.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HANDWRITTEN } from './handwritten.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const date = process.argv.find((a) => a.startsWith('--date='))?.slice(7) ?? new Date().toISOString().slice(0, 10);

const raw = [...files.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))), ...HANDWRITTEN];

// Same letters and digits = same message, whatever the punctuation and case.
const norm = (s) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
// A generator sometimes answers in English whatever language was asked for. Chinese must contain Han
// characters. For the other languages a message made mostly of everyday English words is dropped,
// unless the style asked for a mix (Spanglish, Hinglish). Hindi in Latin letters is kept in every
// style: Gemini wrote most of its Hindi that way, which is also how many people type it.
const HAN = /[一-鿿]/;
const ENGLISH = new Set('the a an and or but is are was am be been i my me you your he she his her it its we they this that to of in on at for with from not no so very just now here there have has had do did can will would feel feeling like about today when what how if as up out am im its dont cant'.split(' '));
const mostlyEnglish = (text) => {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  return words.length >= 4 && words.filter((w) => ENGLISH.has(w.replace(/'/g, ''))).length / words.length > 0.45;
};
// Rows read by the author while tuning this cleaning step. They may not sit in the held-out batch
// (it has to stay unread), so they are forced into the working batch.
const SEEN_WHILE_CLEANING = ['mujhe saans nhi aa rhi abhi dhoob', 'aj subh 2 baar behosh', 'Dad ko aaj achanak kuch samajh', 'mummy ka chehra ek taraf', 'subah se dawayi time pe li hai aur chaye', 'kal se tabiyat thodi thik', 'na behosh na chakkar', 'Mumma ne aaj thoda sa saman', 'meri chest me operation se pehle', 'ghar me sab theek thak hai aur kal dhoop', 'Arre beta aj Ghar py', 'ankles thode puffy', 'Pvt lsc ns mn ft'];
const dropped = { empty: 0, duplicate: 0, wrongLanguage: 0, long: 0 };
const seen = new Set();
const rows = [];
for (const r of raw) {
  const text = String(r.text ?? '').replace(/\s+/g, ' ').trim();
  if (text.length < 2) { dropped.empty++; continue; }
  if (text.length > 1500) { dropped.long++; continue; }
  if (r.lang === 'zh' ? !HAN.test(text) : r.lang !== 'en' && r.style !== 'non_native' && mostlyEnglish(text)) { dropped.wrongLanguage++; continue; }
  const k = `${r.lang}:${norm(text)}`;
  if (seen.has(k)) { dropped.duplicate++; continue; }
  seen.add(k);
  rows.push({ ...r, text });
}

// Deterministic shuffle: the same raw files always give the same split.
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261010);
const groups = new Map();
for (const r of rows.sort((a, b) => (a.key + a.text < b.key + b.text ? -1 : 1))) {
  const g = `${r.lang}|${r.category}`;
  groups.set(g, [...(groups.get(g) ?? []), r]);
}
const batches = { dev: [], heldout: [] };
for (const list of groups.values()) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  list.forEach((r, i) => batches[i % 3 === 2 && !SEEN_WHILE_CLEANING.some((s) => r.text.startsWith(s)) ? 'heldout' : 'dev'].push(r));
}

const SOURCE = { lmstudio: 'qwen2.5-7b-instruct (LM Studio, local)', gemini: 'gemini', claude: 'claude-opus-5-5 (hand-written, rules unread)' };
for (const [batch, list] of Object.entries(batches)) {
  const counters = {};
  const out = list
    .sort((a, b) => (a.lang + a.category + a.text < b.lang + b.category + b.text ? -1 : 1))
    .map((r) => {
      counters[r.lang] = (counters[r.lang] ?? 0) + 1;
      return {
        id: `${batch === 'dev' ? 'ia' : 'ib'}-${r.lang}-${String(counters[r.lang]).padStart(3, '0')}`,
        lang: r.lang,
        label: r.label,
        category: r.category,
        style: r.style,
        source: r.provider === 'gemini' ? r.model : SOURCE[r.provider],
        text: r.text,
      };
    });
  const file = path.join(ROOT, 'evals', `independent-${date}${batch === 'heldout' ? '-heldout' : ''}.jsonl`);
  fs.writeFileSync(file, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const by = (f) => Object.entries(out.reduce((m, r) => ({ ...m, [f(r)]: (m[f(r)] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`${batch}: ${out.length} rows -> ${path.relative(ROOT, file)}\n  ${by((r) => r.lang)}\n  ${by((r) => r.label)}\n  ${by((r) => r.source)}`);
}
console.log('dropped:', JSON.stringify(dropped));
