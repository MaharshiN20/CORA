// Build machine translations of every patient-facing template (P2-11).
//
//   npm run i18n:build                   # every non-native language in enroll.languages()
//   npm run i18n:build -- --langs vi,hi  # specific languages
//   npm run i18n:build -- --force        # re-translate keys that already exist
//
// Uses the LLM chain (Claude -> Ollama -> LM Studio). Output goes to
// src/core/i18n-generated/<lang>.json, marked needsReview: a bilingual reviewer should
// check it before real patients see it. Placeholders ({name}, {med}...) are validated;
// a key whose translation drops or invents one is retried once, then left out (English fallback).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function placeholdersMatch(en, tr, placeholdersOf) {
  return JSON.stringify(placeholdersOf(en)) === JSON.stringify(placeholdersOf(tr));
}

// Pure-ish core: translate `keys` for one language with an injected `complete` (tests mock it).
// onProgress(strings, missing) runs after every key so long runs are saved and can resume.
export async function buildLanguage({ lang, languageName, keys, enTemplate, placeholdersOf, complete, existing = {}, force = false, log = () => {}, onProgress = () => {} }) {
  const strings = { ...(force ? {} : existing) };
  const missing = [];
  const system =
    `Translate this message template from a heart-health app into ${languageName} for an elderly patient. ` +
    'Keep it simple and warm. Keep every placeholder in curly braces EXACTLY as written, e.g. {name}, {med} (do not translate or remove them). ' +
    'Keep emojis, numbers, line breaks, "911", "HeartBridge", "JOIN", "Medicare" and slash commands like /checkin unchanged. Output only the translation.';
  for (const key of keys) {
    if (strings[key]) continue;
    const en = enTemplate(key);
    let tr = null;
    for (let attempt = 0; attempt < 2 && !tr; attempt++) {
      const out = (await complete(system, en, 600))?.trim();
      if (out && placeholdersMatch(en, out, placeholdersOf)) tr = out;
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
    const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).strings : {};
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
