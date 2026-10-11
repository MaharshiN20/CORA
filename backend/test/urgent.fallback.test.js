// "Call 911" reaches ko / ar / pt / tl / ht patients in their own language, instantly, with no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLM_PROVIDER = 'none';
const i18n = await import('../src/core/i18n.js');
const { URGENT_FALLBACK, REVIEWED } = await import('../src/core/urgent-fallback.js');

const KEYS = ['red_911', 'red_interrupt', 'proxy_red_911', 'red_lock', 'proxy_red_lock', 'safety_net_911'];

test('every language has every urgent sentence, each says 911, and placeholders match the English', () => {
  for (const lang of ['ko', 'ar', 'pt', 'tl', 'ht']) {
    for (const key of KEYS) {
      const tr = URGENT_FALLBACK[lang][key];
      assert.ok(tr, `${lang}.${key}`);
      assert.ok(tr.includes('911'), `${lang}.${key} says 911`);
      assert.deepEqual(i18n.placeholdersOf(tr), i18n.placeholdersOf(i18n.enTemplate(key)), `${lang}.${key} placeholders`);
    }
    assert.equal(REVIEWED[lang], null, 'honest: nobody has reviewed these yet');
  }
});

test('localizeUrgent returns the hand-written sentence, filled in, with the model off', async () => {
  const en = i18n.t('en', 'red_interrupt', { name: 'Kim' });
  assert.match(await i18n.localizeUrgent('ko', en), /911/);
  assert.match(await i18n.localizeUrgent('ko', en), /[가-힣]/);
  const en2 = i18n.t('en', 'red_911', { name: 'Maria', caregiver: 'Ana' });
  const pt = await i18n.localizeUrgent('pt', en2);
  assert.match(pt, /Maria/);
  assert.match(pt, /Ana/);
  assert.match(pt, /LIGUE PARA O 911/);
});

test('the safety line under a question is the hand-written one; the question is still localized', async () => {
  const q = `${i18n.t('en', 'ask_breath')}\n\n${i18n.t('en', 'safety_net_911')}`;
  const out = await i18n.localize('tl', q);
  assert.ok(out.endsWith(URGENT_FALLBACK.tl.safety_net_911));
});

test('languages with generated templates (vi / hi / zh) and native ones are untouched', async () => {
  const en = i18n.t('en', 'red_interrupt', { name: 'Kim' });
  assert.equal(await i18n.localizeUrgent('en', en), en);
  assert.notEqual(await i18n.localizeUrgent('vi', en), en);
});
