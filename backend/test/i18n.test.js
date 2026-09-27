// P2-11: generated template translations (offline, consistent) + the build tool.
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-i18n-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let i18n, build, store, agent, llm;
before(async () => {
  i18n = await import('../src/core/i18n.js');
  build = await import('../tools/i18n-build.js');
  store = await import('../src/store.js');
  agent = await import('../src/core/agent.js');
  llm = await import('../src/core/llm/index.js');
  await llm.detect({ force: true }); // 'none'
});
afterEach(() => i18n._setGenerated('xx', null));

const XX = {
  meta: { lang: 'xx', needsReview: true },
  strings: {
    greeting: 'XX-morning {name}! 💙',
    ask_weight: 'XX-weight?',
    advice_header: 'XX-tips:',
    advice_low_sodium: 'XX-low-salt',
  },
};

test('localize uses the generated template with the real values, with no LLM at all', async () => {
  i18n._setGenerated('xx', XX);
  const en = i18n.t('xx', 'greeting', { name: 'Thanh' }); // non-native -> English text, remembered
  assert.match(en, /^Good morning Thanh/);
  assert.equal(await i18n.localize('xx', en), 'XX-morning Thanh! 💙');
});

test('multi-line messages are rebuilt line by line (advice lists)', async () => {
  i18n._setGenerated('xx', XX);
  const text = `${i18n.t('xx', 'advice_header')}\n• ${i18n.t('xx', 'advice_low_sodium')}`;
  assert.equal(await i18n.localize('xx', text), 'XX-tips:\n• XX-low-salt');
});

test('missing template offline -> best effort: translated lines kept, the rest stays English', async () => {
  i18n._setGenerated('xx', XX);
  const text = `${i18n.t('xx', 'advice_header')}\n• ${i18n.t('xx', 'advice_watch_fluids')}`;
  const out = await i18n.localize('xx', text);
  assert.match(out, /^XX-tips:\n• Watch how much you drink/);
});

test('native languages are untouched; unknown text passes through', async () => {
  i18n._setGenerated('xx', XX);
  assert.equal(await i18n.localize('es', 'hola'), 'hola');
  assert.equal(await i18n.localize('xx', 'totally new text'), 'totally new text');
});

test('end to end: a patient in a generated language gets a translated check-in offline', async () => {
  i18n._setGenerated('xx', XX);
  store.reset();
  store.updatePatient('p5', { language: 'xx' });
  const r = await agent.startCheckin('p5');
  assert.equal(r[0].text, 'XX-morning Dorothy! 💙');
  assert.equal(r[1].text, 'XX-weight?');
  assert.match(r[0].textEn, /^Good morning Dorothy/); // English twin kept for the dashboard
});

test('placeholder helpers', () => {
  assert.deepEqual(i18n.placeholdersOf('Hi {name}, take {med} at {time}'), ['{med}', '{name}', '{time}']);
  assert.ok(build.placeholdersMatch('Hi {name}', 'Chào {name}', i18n.placeholdersOf));
  assert.ok(!build.placeholdersMatch('Hi {name}', 'Chào {tên}', i18n.placeholdersOf));
  assert.ok(!build.placeholdersMatch('Hi {name}', 'Chào bạn', i18n.placeholdersOf));
});

test('buildLanguage: translates all keys, retries bad placeholders once, reports missing', async () => {
  const calls = {};
  const complete = async (_sys, en) => {
    calls[en] = (calls[en] ?? 0) + 1;
    if (en.includes('{name}') && en.startsWith('Good morning')) return calls[en] === 1 ? 'Chào bạn!' : 'Chào {name}!'; // fixed on retry
    if (en.includes('{med}')) return 'broken'; // never keeps {med}
    return `VI:${en}`;
  };
  const keys = ['greeting', 'yes', 'ask_diuretic'];
  const { strings, missing } = await build.buildLanguage({
    lang: 'vi', languageName: 'Vietnamese', keys, enTemplate: i18n.enTemplate, placeholdersOf: i18n.placeholdersOf, complete,
  });
  assert.equal(strings.greeting, 'Chào {name}!');
  assert.equal(strings.yes, 'VI:✅ Yes');
  assert.deepEqual(missing, ['ask_diuretic']);
  assert.equal(calls[i18n.enTemplate('ask_diuretic')], 2);
});

test('buildLanguage keeps existing translations unless --force', async () => {
  let n = 0;
  const complete = async (_s, en) => { n++; return `NEW:${en}`; };
  const args = { lang: 'vi', languageName: 'Vietnamese', keys: ['yes', 'no'], enTemplate: i18n.enTemplate, placeholdersOf: i18n.placeholdersOf, complete };
  const kept = await build.buildLanguage({ ...args, existing: { yes: 'Có' } });
  assert.equal(kept.strings.yes, 'Có');
  assert.equal(n, 1);
  const forced = await build.buildLanguage({ ...args, existing: { yes: 'Có' }, force: true });
  assert.match(forced.strings.yes, /^NEW:/);
});

test('committed generated files (if any) are well-formed and keep every placeholder', async () => {
  const fs = await import('node:fs');
  const dir = i18n.generatedDir();
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  for (const f of files) {
    const { meta, strings } = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.equal(meta.needsReview, true, `${f}: must be flagged needsReview`);
    for (const [key, tr] of Object.entries(strings)) {
      assert.ok(i18n.enTemplate(key) !== undefined, `${f}: unknown key ${key}`);
      assert.ok(build.placeholdersMatch(i18n.enTemplate(key), tr, i18n.placeholdersOf), `${f}: ${key} placeholders changed`);
    }
  }
});
