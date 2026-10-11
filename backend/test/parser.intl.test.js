// K15: hand-written red-flag phrases for Vietnamese, Hindi and Chinese (core/redflags-intl.js),
// and the "call 911" line that goes under every check-in question when no model is available.
// These decide a 911 instruction, so the calm side is tested as hard as the emergency side.
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-parser-intl-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let parser, intl, store, agent, i18n, llm;
before(async () => {
  parser = await import('../src/core/parser.js');
  intl = await import('../src/core/redflags-intl.js');
  store = await import('../src/store.js');
  agent = await import('../src/core/agent.js');
  i18n = await import('../src/core/i18n.js');
  llm = await import('../src/core/llm/index.js');
});
beforeEach(() => {
  store.reset();
  llm._reset();
});
afterEach(() => llm._reset());

const flags = (text) => Object.keys(intl.detectIntlRedFlags(text)).sort().join(',');
// [text, expected flags]; '' = nothing may be raised.
function check(rows) {
  for (const [text, want] of rows) assert.equal(flags(text), want, text);
}

// ---------- Vietnamese ----------
test('vi: chest pain, in either word order, with or without diacritics', () => {
  check([
    ['đau ngực', 'chestPain'],
    ['ngực tôi đau quá', 'chestPain'],
    ['tôi bị đau ở ngực trái', 'chestPain'],
    ['đau thắt ngực từ sáng tới giờ', 'chestPain'],
    ['ngực hơi tức', 'chestPain'],
    ['ngực có cảm giác như bị đè nặng', 'chestPain'],
    ['dau nguc qua', 'chestPain'],
    ['tôi không ngủ được vì đau ngực', 'chestPain'], // "không" belongs to "ngủ được"
    ['không khỏe đau ngực', 'chestPain'], // "not well, chest pain"
    ['cha tôi đau ngực', 'chestPain'], // cha = father; chả = not
  ]);
});

test('vi: negated, resolved and look-alike phrases stay calm', () => {
  check([
    ['không đau ngực, không chóng mặt', ''],
    ['ngực không đau', ''],
    ['không bị đau ngực', ''],
    ['chưa bao giờ đau ngực', ''],
    ['hết đau ngực rồi, cảm ơn cô', ''],
    ['k dau nguc', ''],
    ['tức là hôm nay tôi khỏe', ''], // "tức là" = that is
    ['đầu ngực bị ngứa', ''], // đầu, not đau
    ['ngực rất bình thường', ''], // rất (very), not rát (burning)
    ['hơi chóng mặt', ''],
    ['chân sưng nhiều hơn hôm qua', ''],
  ]);
});

test('vi: breathing: at rest is an emergency, on exertion is not, lying down is orthopnea', () => {
  check([
    ['ngồi yên cũng khó thở', 'breathRest'],
    ['ngồi nghỉ mà vẫn khó thở', 'breathRest'],
    ['ngồi không cũng thấy khó thở', 'breathRest'], // "ngồi không" = sitting idle, not a negation
    ['nghỉ ngơi rồi mà vẫn khó thở', 'breathRest'],
    ['khó thở ngay cả khi ngồi', 'breathRest'],
    ['tôi không thở được', 'breathRest'],
    ['thở không nổi', 'breathRest'],
    ['khong tho duoc', 'breathRest'],
    ['đi bộ thì hụt hơi', ''],
    ['đi bộ nhanh thì khó thở, ngồi nghỉ là hết', ''],
    ['nghỉ một lát thì hết khó thở', ''],
    ['nghỉ thì đỡ khó thở', ''],
    ['ngồi yên thì không khó thở', ''],
    ['sáng nay ngồi dậy hơi khó thở một chút', ''], // on sitting up, not while sitting
    ['thở bình thường', ''],
    ['tôi không ngủ được vì khó thở khi nằm', 'orthopnea'],
    ['nằm xuống là không thở được', 'orthopnea'],
  ]);
});

test('vi: fainting and confusion need the right word, not a similar one', () => {
  check([
    ['tôi bị ngất sáng nay', 'fainting'],
    ['bà tôi vừa bị xỉu trong nhà tắm', 'fainting'],
    ['ông ấy bất tỉnh rồi', 'fainting'],
    ['hôm nay nóng muốn xỉu', ''], // so hot I could faint
    ['chờ tôi một xíu', ''], // xíu = a moment
    ['mũi tôi bị ngạt', ''], // ngạt = blocked
    ['tòa nhà cao ngất', ''],
    ['không bị ngất', ''],
    ['Mẹ tôi có vẻ lú lẫn, không biết mình đang ở đâu', 'confusion'],
    ['ba tôi nói sảng, không nhận ra ai hết', 'confusion'],
    ['không lú lẫn gì cả', ''],
    ['không biết thuốc ở đâu', ''],
    ['mẹ sang chơi hôm nay', ''], // mẹ sang (mum is coming over), not mê sảng
    ['me sang choi hom nay', ''],
  ]);
});

// ---------- Hindi ----------
test('hi: chest pain in Devanagari and in Latin letters', () => {
  check([
    ['सीने में दर्द', 'chestPain'],
    ['छाती में बहुत दर्द हो रहा है', 'chestPain'],
    ['नमस्ते! सब ठीक है, बस सीने में जकड़न है', 'chestPain'],
    ['सीना भारी लग रहा है', 'chestPain'],
    ['दर्द हो रहा है छाती में', 'chestPain'],
    ['सीने में दर्द है नींद नहीं आ रही', 'chestPain'], // the नहीं belongs to sleep
    ['seene me dard ho raha hai', 'chestPain'],
    ['chest me dard hai', 'chestPain'],
  ]);
});

test('hi: the negation comes after the symptom, and "not going away" is not a negation', () => {
  check([
    ['सीने में दर्द नहीं है', ''],
    ['सीने में कोई दर्द नहीं है', ''],
    ['सीने में दर्द बिल्कुल नहीं है', ''],
    ['सीने में दर्द कभी नहीं हुआ', ''],
    ['न सीने में दर्द है न चक्कर', ''],
    ['कमर में दर्द है सीने में नहीं', ''],
    ['सीने में दर्द तो नहीं पर थकान है', ''],
    ['seene me dard nahi hai', ''],
    ['सीने में दर्द नहीं जा रहा', 'chestPain'], // is NOT going away
    ['सीने में दर्द नहीं रुक रहा', 'chestPain'], // is NOT stopping
    ['सीने में दर्द कम नहीं हो रहा', 'chestPain'], // is NOT easing
  ]);
});

test('hi: breathing, fainting and confusion', () => {
  check([
    ['आराम करते हुए भी सांस नहीं आ रही', 'breathRest'],
    ['सांस नहीं ले पा रहा हूं', 'breathRest'],
    ['साँस नहीं आ रही', 'breathRest'], // chandrabindu spelling
    ['दम घुट रहा है', 'breathRest'],
    ['बैठे बैठे भी सांस फूल रही है', 'breathRest'],
    ['saans nahi aa rahi', 'breathRest'],
    ['चलने पर सांस फूलती है', ''],
    ['सीढ़ियां चढ़ने पर सांस फूलती है', ''],
    ['सांस नहीं आ रही थी कल चलते समय', ''],
    ['आराम करने पर सांस फूलना बंद हो जाता है', ''], // resting stops it
    ['सांस लेने में तकलीफ नहीं है', ''],
    ['सांस ठीक है', ''],
    ['रात में लेटने पर सांस लेने में तकलीफ होती है', 'orthopnea'],
    ['लेटते ही सांस नहीं आती', 'orthopnea'],
    ['मैं बेहोश हो गया था', 'fainting'],
    ['मम्मी अचानक बेहोश होकर गिर गईं', 'fainting'],
    ['behosh ho gaye the', 'fainting'],
    ['मैं बेहोश नहीं हुआ, बस चक्कर आया था', ''],
    ['चक्कर आ रहे हैं', ''],
    ['पापा उलझन में हैं, उन्हें कुछ समझ नहीं आ रहा', 'confusion'],
    ['दादी किसी को पहचान नहीं रही हैं', 'confusion'],
    ['उन्हें होश नहीं है', 'confusion'],
    ['मैं उलझन में नहीं हूं', ''],
    ['दवा को लेकर थोड़ी उलझन में हूं, सुबह वाली गोली कौन सी है?', ''], // confused about the pills
    ['मुझे कुछ समझ नहीं आ रहा, सवाल दोबारा भेजिए', ''], // doesn't understand the question
    ['पता नहीं दवा कहां है', ''],
  ]);
});

// ---------- Chinese ----------
test('zh: chest pain in simplified and traditional characters', () => {
  check([
    ['胸口痛', 'chestPain'],
    ['你好!孙子来看我了,很开心。就是胸口有点闷', 'chestPain'],
    ['胸口像压了块石头', 'chestPain'],
    ['心口疼得厉害', 'chestPain'],
    ['胸悶,喘不過氣', 'chestPain'],
    ['我很不舒服胸口痛', 'chestPain'], // 不舒服 is not a negation
    ['我没睡好胸口痛', 'chestPain'], // nor is 没睡好
    ['心绞痛又犯了', 'chestPain'],
    ['没有胸痛,也不头晕', ''],
    ['胸口不痛', ''],
    ['胸口已经不闷了', ''],
    ['没有感觉胸痛', ''],
    ['胸口不疼就是有点累', ''],
    ['我有心绞痛病史', ''], // history
    ['胸罩太紧了', ''],
    ['拍了胸片', ''],
    ['看到孙子生病我很心疼', ''], // 心疼 = feel sorry for
  ]);
});

test('zh: breathing, fainting and confusion', () => {
  check([
    ['坐着也喘不过气', 'breathRest'],
    ['休息的时候也喘不上气', 'breathRest'],
    ['休息了一天还是气短', 'breathRest'],
    ['我无法呼吸', 'breathRest'],
    ['不能呼吸了', 'breathRest'],
    ['走路的时候喘不上气', ''],
    ['爬楼梯的时候喘不过气,休息一下就好了', ''],
    ['走路喘不过气休息一下就好了', ''],
    ['坐车的时候有点气喘', ''],
    ['休息时没有气喘', ''],
    ['休息不好气短', ''],
    ['呼吸正常', ''],
    ['晚上躺下就喘不过气', 'orthopnea'],
    ['半夜憋气醒过来', 'orthopnea'],
    ['昨天晕倒了', 'fainting'],
    ['爸爸刚才昏过去了', 'fainting'],
    ['她失去意识了', 'fainting'],
    ['差点晕过去', 'fainting'],
    ['没有晕倒,只是有点头晕', ''],
    ['有点头晕', ''],
    ['今天累得快晕倒了', ''], // so tired I could faint
    ['笑晕过去了', ''],
    ['我妈妈糊涂了,不知道自己在哪里', 'confusion'],
    ['奶奶神志不清,认不出人了', 'confusion'],
    ['他开始说胡话', 'confusion'],
    ['我真糊涂,又忘了量体重', ''], // silly me
    ['一时糊涂吃错了药', ''],
    ['妈妈没有糊涂', ''],
    ['脑子不糊涂', ''],
    ['不知道在哪里买药', ''],
  ]);
});

// ---------- across languages ----------
test('English and Spanish text is untouched by these lists, and empty input is fine', () => {
  check([
    ['I have chest pain', ''],
    ['no chest pain today', ''],
    ['sin dolor de pecho', ''],
    ['me sangra la nariz', ''],
    ['the sine wave', ''],
    ['176', ''],
    ['', ''],
  ]);
  assert.deepEqual(intl.detectIntlRedFlags(null), {});
  assert.deepEqual(intl.detectIntlRedFlags(undefined), {});
  // and the English / Spanish rules still do their own job through the same entry point
  assert.equal(parser.detectRedFlags('I have chest pain').chestPain, true);
  assert.equal(parser.detectRedFlags('no chest pain today'), null);
  assert.equal(parser.detectRedFlags('me duele el pecho').chestPain, true);
});

test('the lists feed the same answers as the English rules (parseFreeText)', () => {
  assert.deepEqual(parser.parseFreeText('đau ngực'), { chestPain: true });
  assert.deepEqual(parser.parseFreeText('सांस नहीं ले पा रहा हूं'), { breath: 'rest' });
  assert.deepEqual(parser.parseFreeText('爸爸刚才昏过去了'), { fainting: true });
  assert.deepEqual(parser.parseFreeText('奶奶神志不清'), { confusion: true });
  assert.deepEqual(parser.parseFreeText('晚上躺下就喘不过气'), { orthopnea: true });
  assert.deepEqual(parser.parseFreeText('không đau ngực'), {});
});

test('a Vietnamese emergency typed outside a check-in is escalated with no model at all', async () => {
  const replies = await agent.handleInbound({ patientId: 'p3', text: 'tôi không thở được' }); // Thanh, vi
  assert.equal(replies[0].urgent, true);
  assert.match(replies[0].text, /911/);
  const alert = store.listAlerts()[0];
  assert.equal(alert.tier, 'RED');
  assert.equal(alert.patientId, 'p3');
  assert.ok(!store.listAudit('p3').some((e) => e.type === 'llm_parse'), 'no model was involved');
});

test('a calm Vietnamese message raises nothing', async () => {
  const replies = await agent.handleInbound({ patientId: 'p3', text: 'không đau ngực, không khó thở' });
  assert.notEqual(replies[0]?.urgent, true);
  assert.equal(store.listAlerts().filter((a) => a.tier === 'RED').length, 0);
});

// ---------- the 911 line under check-in questions ----------
const LINE_EN = () => i18n.t('en', 'safety_net_911');
const fakeProvider = () => llm._use([{ name: 'fake', model: 'm', chat: async () => '' }]);

test('i18n: the safety line exists in en and es and names 911', () => {
  assert.match(LINE_EN(), /chest pain.*breathe.*911/);
  assert.match(i18n.t('es', 'safety_net_911'), /dolor de pecho.*respirar.*911/);
  assert.notEqual(i18n.t('es', 'safety_net_911'), LINE_EN());
});

test('no model + a language that is not en / es: every check-in question carries the 911 line', async () => {
  const first = await agent.startCheckin('p3'); // Thanh, Vietnamese
  const question = first.at(-1);
  assert.match(question.text, /hãy gọi 911/, 'in Vietnamese, from the template file');
  assert.ok(question.textEn.endsWith(LINE_EN()), 'the dashboard copy says it in English');
  assert.ok(!first[0].text.includes('911'), 'the greeting is left alone');
  assert.ok(question.buttons?.length, 'the buttons are still there');

  // every following question too
  const seen = [];
  for (const buttonData of ['ci:rf:none', 'ci:wt:skip', 'ci:breath:normal', 'ci:swell:none']) {
    const replies = await agent.handleInbound({ patientId: 'p3', buttonData });
    const next = replies.at(-1);
    if (!store.getPatient('p3').checkin?.state || store.getPatient('p3').checkin.state === 'idle') break;
    seen.push(next.text);
    assert.match(next.text, /911/, `after ${buttonData}`);
    assert.ok(next.textEn.endsWith(LINE_EN()));
  }
  assert.ok(seen.length >= 3, 'several questions were checked');
});

test('a question the patient has to be asked again still carries the line', async () => {
  await agent.startCheckin('p3');
  await agent.handleInbound({ patientId: 'p3', buttonData: 'ci:rf:none' });
  const again = await agent.handleInbound({ patientId: 'p3', text: 'hmm' }); // not a weight
  assert.match(again.at(-1).text, /911/);
  assert.ok(again.at(-1).textEn.endsWith(LINE_EN()));
});

test('Hindi and Chinese get the line in their own language; Korean and Arabic get the hand-written line (core/urgent-fallback.js)', async () => {
  for (const [lang, pattern] of [['hi', /911 पर कॉल करें/], ['zh', /请立即拨打 911/], ['ko', /911에 전화하세요/], ['ar', /911 فورًا/]]) {
    store.reset();
    store.updatePatient('p3', { language: lang });
    const question = (await agent.startCheckin('p3')).at(-1);
    assert.match(question.text, pattern, lang);
    assert.ok(question.textEn.endsWith(LINE_EN()), lang);
  }
});

test('English and Spanish patients never get the extra line: the rules read their emergencies', async () => {
  for (const id of ['p1', 'p2']) {
    const replies = await agent.startCheckin(id); // Maria (es), Robert (en)
    for (const r of replies) assert.ok(!/911/.test(r.text), `${id}: ${r.text}`);
  }
});

test('with a model available the line is not added: the parser reads free text again', async () => {
  fakeProvider();
  assert.equal(llm.enabled(), true);
  const replies = await agent.startCheckin('p3');
  for (const r of replies) assert.ok(!/911/.test(r.textEn), r.textEn);
});

test('the line never replaces the real emergency message', async () => {
  await agent.startCheckin('p3');
  const replies = await agent.handleInbound({ patientId: 'p3', buttonData: 'ci:rf:chest' });
  assert.equal(replies[0].urgent, true);
  assert.match(replies[0].text, /911/);
  assert.ok(!replies[0].textEn.includes(LINE_EN()), 'the RED message is its own text, not a question with a footer');
});

test('the committed template files carry the line for vi, hi and zh, flagged for review', async () => {
  const fs = await import('node:fs');
  for (const lang of ['vi', 'hi', 'zh']) {
    const { meta, strings } = JSON.parse(fs.readFileSync(path.join(i18n.generatedDir(), `${lang}.json`), 'utf8'));
    assert.match(strings.safety_net_911, /911/, lang);
    assert.equal(meta.needsReview, true, lang);
    assert.ok(meta.humanEdited.includes('safety_net_911'), `${lang}: marked as hand-written so a rebuild keeps it`);
  }
});
