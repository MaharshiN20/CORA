// Rules for the five offered languages that had none (audit 2026-10-11 S4): ko, ar, pt, tl, ht.
// The phrases were written by the rules' author and have no native-speaker review (see REVIEW in
// core/redflags-more.js): they are a regression guard and a floor, not evidence of real-world recall.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLM_PROVIDER = 'none';
const parser = await import('../src/core/parser.js');
const more = await import('../src/core/redflags-more.js');
const red = (t) => {
  const a = parser.parseFreeText(t);
  return !!(a.chestPain || a.breath === 'rest' || a.fainting || a.confusion || a.otherEmergency);
};

const EMERGENCY = {
  ko: ['가슴이 너무 아파요', '가슴이 답답하고 조여요', '숨을 못 쉬겠어요', '숨이 막혀요', '호흡 곤란이에요', '방금 기절했어요', '남편이 쓰러졌어요', '아버지가 쓰러졌는데 대답을 안 해요', '엄마가 혼란스러워하고 여기가 어디냐고 물어요', '죽을 것 같아요', '깨워도 안 일어나요'],
  ar: ['عندي ألم في الصدر', 'صدري يؤلمني بشدة', 'ضغط على صدري', 'لا أستطيع التنفس', 'أختنق', 'أغمي علي', 'فقدت الوعي', 'أبي لا يستجيب', 'جدي مشوش ولا يعرف أين هو', 'أشعر أنني سأموت'],
  pt: ['estou com dor no peito', 'sinto um aperto forte no peito', 'meu peito está doendo', 'não consigo respirar', 'eu desmaiei', 'meu marido caiu e não responde', 'minha mãe está confusa', 'acho que vou morrer', 'estou sufocando'],
  tl: ['masakit ang dibdib ko', 'may kirot sa dibdib ko', 'hindi ako makahinga', 'nahimatay ako', 'bumagsak si tatay at hindi na sumasagot', 'litong-lito si nanay', 'nasasakal ako'],
  ht: ['mwen gen doulè nan pwatrin', 'pwatrin mwen fè mal anpil', 'mwen pa ka respire', 'm ap toufe', 'mwen svanwi', 'manman m tonbe epi li pa reponn', 'mwen pral mouri'],
};
for (const [lang, list] of Object.entries(EMERGENCY)) for (const t of list) test(`${lang} emergency: ${t}`, () => assert.equal(red(t), true));

const CALM = {
  ko: ['가슴이 안 아파요', '가슴 통증은 없어요', '숨 쉬는 게 힘들지 않아요', '기절한 적 없어요', '오늘은 괜찮아요', '체중이 172파운드예요'],
  ar: ['ما عندي ألم في الصدر', 'لا يوجد ألم في الصدر', 'بدون ضيق في الصدر', 'أنا بخير اليوم', 'وزني 172'],
  pt: ['não tenho dor no peito', 'sem dor no peito', 'estou bem hoje', 'meu peso é 172', 'nunca desmaiei'],
  tl: ['wala akong sakit sa dibdib', 'hindi masakit ang dibdib ko', 'ayos lang ako ngayon', 'ang timbang ko ay 172'],
  ht: ['mwen pa gen doulè nan pwatrin', 'mwen byen jodi a', 'pwa mwen se 172'],
};
for (const [lang, list] of Object.entries(CALM)) for (const t of list) test(`${lang} calm: ${t}`, () => assert.equal(red(t), false));

test('English and Spanish sentences never go through the Latin-script lists of pt / tl / ht', () => {
  for (const t of ['I am fine today, my weight is 172', 'no tengo dolor de pecho', 'mi esposo está bien', 'can I eat soup', 'I have no chest pain']) assert.deepEqual(more.detectMoreRedFlags(t), {});
});

test('each language has a REVIEW entry that says nobody has reviewed it yet', () => {
  assert.deepEqual(Object.keys(more.REVIEW).sort(), ['ar', 'ht', 'ko', 'pt', 'tl']);
  for (const r of Object.values(more.REVIEW)) assert.equal(r.reviewedBy, null);
});

test('the reason for an unresponsive / dying report is not "Fainted"', () => {
  assert.equal(parser.parseFreeText('죽을 것 같아요').otherEmergency, 'dying');
  assert.equal(parser.parseFreeText('아버지가 쓰러졌는데 대답을 안 해요').otherEmergency, 'unresponsive');
});

test('hostile input is fast (no ReDoS)', () => {
  for (const t of ['가슴 '.repeat(20000), 'صدر '.repeat(20000), 'dor '.repeat(20000), 'dibdib '.repeat(20000), 'pwatrin '.repeat(20000)]) {
    const t0 = performance.now();
    parser.parseFreeText(t);
    assert.ok(performance.now() - t0 < 1500, `${t.slice(0, 8)} took ${performance.now() - t0} ms`);
  }
});
