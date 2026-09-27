// Build machine translations of every patient-facing template (P2-11).
//
//   npm run i18n:build                   # every non-native language in enroll.languages()
//   npm run i18n:build -- --langs vi,hi  # specific languages
//   npm run i18n:build -- --force        # re-translate keys that already exist
//
// Uses the LLM chain (Claude -> Gemini -> Ollama -> LM Studio). Output goes to
// src/core/i18n-generated/<lang>.json, marked needsReview: a bilingual reviewer should
// check it before real patients see it. Placeholders ({name}, {med}...) are validated;
// a key whose translation drops or invents one is retried once, then left out (English fallback).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function placeholdersMatch(en, tr, placeholdersOf) {
  return JSON.stringify(placeholdersOf(en)) === JSON.stringify(placeholdersOf(tr));
}

// A translation is never several times longer than its source. Small local models given a
// short input ("✅ Yes") sometimes invent a whole message instead, so reject runaway output.
export function plausibleLength(en, tr) {
  return tr.length <= en.length * 4 + 40;
}

// Models sometimes echo the delimiters back.
const unwrap = (s) =>
  s
    .replace(/^\s*<text>\s*/i, '')
    .replace(/\s*<\/text>\s*$/i, '')
    .replace(/\*\*(.+?)\*\*/g, '$1') // Markdown bold: messages are sent as plain text
    .trim();

// Pure-ish core: translate `keys` for one language with an injected `complete` (tests mock it).
// onProgress(strings, missing) runs after every key so long runs are saved and can resume.
export async function buildLanguage({ lang, languageName, keys, enTemplate, placeholdersOf, complete, existing = {}, force = false, log = () => {}, onProgress = () => {} }) {
  const strings = { ...(force ? {} : existing) };
  const missing = [];
  // No example tokens in the prompt: small models parrot them into short strings.
  const system =
    `You are a professional medical translator. Translate the text inside <text></text> into ${languageName} ` +
    'for an elderly patient, simply and warmly, using the respectful/formal form of address (e.g. "usted" in Spanish). ' +
    'Translate ONLY that text: never add sentences, greetings, links or hashtags. ' +
    'Words in curly braces are placeholders: copy them unchanged. Keep emojis, numbers, line breaks, brand names and ' +
    'anything starting with "/" unchanged. A short button label stays a short label. Output only the translation, without the tags.';
  for (const key of keys) {
    if (strings[key]) continue;
    const en = enTemplate(key);
    let tr = null;
    for (let attempt = 0; attempt < 2 && !tr; attempt++) {
      const raw = (await complete(system, `<text>${en}</text>`, 600))?.trim();
      const out = raw ? unwrap(raw) : null;
      if (out && placeholdersMatch(en, out, placeholdersOf) && plausibleLength(en, out)) tr = out;
    }
    if (tr) strings[key] = tr;
    else missing.push(key);
    log(`  ${tr ? '✓' : '✗'} ${key}`);
    onProgress(strings, missing);
  }
  return { strings, missing };
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const langsArg = args.find((a, i) => args[i - 1] === '--langs');
  const i18n = await import('../src/core/i18n.js');
  const llm = await import('../src/core/llm/index.js');
  const { languages } = await import('../src/core/enroll.js');

  await llm.detect({ force: true });
  const status = llm.status();
  if (status.provider === 'none') {
    console.error('No LLM provider available (Claude key, Ollama or LM Studio). Start one and retry.');
    process.exit(1);
  }
  const langs = langsArg ? langsArg.split(',') : languages().filter((l) => !l.native).map((l) => l.code);
  console.log(`Translating ${i18n.templateKeys().length} templates into ${langs.join(', ')} with ${status.provider} (${status.model})`);

  fs.mkdirSync(i18n.generatedDir(), { recursive: true });
  for (const lang of langs) {
    const file = path.join(i18n.generatedDir(), `${lang}.json`);
    const prior = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { strings: {}, meta: {} };
    const existing = prior.strings;
    // Human work survives rebuilds: reviewed keys (drop the bilingual safety labels) and hand fixes.
    const keep = { ...(prior.meta?.reviewed && { reviewed: prior.meta.reviewed }), ...(prior.meta?.humanEdited && { humanEdited: prior.meta.humanEdited }) };
    console.log(`\n${lang} (${i18n.languageName(lang)})`);
    const started = Date.now();
    const write = (strings, missing) => {
      const meta = {
        lang,
        language: i18n.languageName(lang),
        needsReview: true,
        provider: status.provider,
        model: status.model,
        generatedAt: new Date().toISOString(),
        total: i18n.templateKeys().length,
        translated: Object.keys(strings).length,
        missing,
        ...keep,
      };
      fs.writeFileSync(file, JSON.stringify({ meta, strings }, null, 2) + '\n');
      return meta;
    };
    const { strings, missing } = await buildLanguage({
      lang,
      languageName: i18n.languageName(lang),
      keys: i18n.templateKeys(),
      enTemplate: i18n.enTemplate,
      placeholdersOf: i18n.placeholdersOf,
      complete: llm.complete,
      existing,
      force,
      log: console.log,
      onProgress: write,
    });
    const meta = write(strings, missing);
    console.log(`→ ${file}: ${meta.translated}/${meta.total} (${missing.length} missing) in ${Math.round((Date.now() - started) / 1000)}s`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
