// S1/S1b (audit 2026-10-11): a nurse's free text must reach the patient intact or not be
// "translated" at all, and a bad model translation is never cached.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-transtrust-${process.pid}.json`);
process.env.LLM_PROVIDER = 'lmstudio';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, nurse, i18n, llm;
const realFetch = globalThis.fetch;
let reply = ''; // what the fake model answers
let calls = 0;
before(async () => {
  store = await import('../src/store.js');
  nurse = await import('../src/core/nurse.js');
  i18n = await import('../src/core/i18n.js');
  llm = await import('../src/core/llm/index.js');
});
beforeEach(async () => {
  llm._reset();
  store.reset();
  calls = 0;
  globalThis.fetch = async (url, opts) => {
    if (String(url).endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }] }));
    if (String(url).endsWith('/v1/chat/completions')) {
      calls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: typeof reply === 'function' ? reply(opts) : reply } }] }));
    }
    return realFetch(url, opts);
  };
  await llm.detect({ force: true });
});

const SRC = 'Your weight went up 3 lb. I will call you at 4:30 PM today.';
const lastOut = (id) => store.listMessages(id).filter((m) => m.direction === 'out' && m.to === 'patient').at(-1);
const setLang = (language) => store.updatePatient('p1', { language });

test('plausibleTranslation: keeps numbers, rejects dropped/invented ones, wrong script, runaway length', () => {
  const ok = i18n.plausibleTranslation;
  assert.equal(ok('zh', SRC, '您的体重增加了3磅。我今天下午4:30给您打电话。'), true);
  assert.equal(ok('zh', SRC, '您的体重增加了3磅。我今天下午给您打电话。'), false, 'dropped 4:30');
  assert.equal(ok('zh', SRC, '您的体重增加了3磅。我今天下午4:30给您打电话。请拨打911。'), false, 'invented 911');
  assert.equal(ok('ar', SRC, 'وزنك زاد 3 أرطال. سأتصل بك في 4:30 مساءً اليوم.'), true);
  assert.equal(ok('ar', SRC, 'وزنك زاد ٣ أرطال. سأتصل بك في ٤:٣٠ مساءً اليوم.'), true, 'Arabic-Indic digits equal ASCII');
  assert.equal(ok('pt', SRC, 'Seu peso subiu 3 lb. Vou ligar às 4:30 PM hoje fähра.'), false, 'stray Cyrillic');
  assert.equal(ok('zh', SRC, 'Your weight went up 3 lb. I will call you at 4:30 PM today.'), false, 'not translated');
  assert.equal(ok('ko', SRC, '안녕하세요 '.repeat(40)), false, 'runaway / numbers gone');
  assert.equal(ok('pt', SRC, ''), false);
  assert.equal(ok('pt', SRC, 'Sure! Seu peso subiu 3 lb. Vou ligar às 4:30 PM hoje.'), false, 'chat noise');
});

test('S1: a Chinese patient gets the nurse body inside an assembled wrapper (sentinel never goes through the model)', async () => {
  setLang('zh');
  reply = (opts) => {
    const sent = JSON.parse(opts.body).messages.at(-1).content;
    assert.ok(!sent.includes('\u0000'), 'no NUL sentinel is sent to the model');
    return '您的体重增加了3磅。我今天下午4:30给您打电话。';
  };
  const r = await nurse.sendNurseMessage('p1', { text: SRC, from: 'Nurse Kim' });
  assert.equal(r.translated, true);
  assert.match(r.text, /Nurse Kim/);
  assert.match(r.text, /我今天下午4:30给您打电话/);
  assert.match(lastOut('p1').text, /4:30/);
});

test('S1b: garbage from the model is not delivered; the nurse\'s English goes out and translated=false', async () => {
  setLang('ko');
  reply = '부모님, 저희 간호사입니다. 😊 911을 부르세요IfNeeded they need immediate help.';
  const r = await nurse.sendNurseMessage('p1', { text: SRC, from: 'Nurse Kim' });
  assert.equal(r.translated, false);
  assert.match(r.text, /Your weight went up 3 lb\. I will call you at 4:30 PM today\./);
  assert.ok(!/911/.test(r.text));
});

test('S1b: a bad translation is not cached: once the model recovers the next message is translated', async () => {
  setLang('zh');
  reply = 'Sure! Here is some prose with no JSON at all. {not valid';
  const text = `${SRC} Please rest.`;
  const bad = await nurse.sendNurseMessage('p1', { text });
  assert.equal(bad.translated, false);
  reply = '您的体重增加了3磅。我今天下午4:30给您打电话。请休息。';
  const good = await nurse.sendNurseMessage('p1', { text });
  assert.equal(good.translated, true);
  assert.match(good.text, /4:30/);
});

test('S1b: localize() also refuses implausible output and does not cache it', async () => {
  reply = '您好！请拨打911。';
  const txt = 'Please weigh yourself at 8 AM.';
  assert.equal(await i18n.localize('zh', txt), txt);
  reply = '请在上午8点称体重。';
  assert.equal(await i18n.localize('zh', txt), '请在上午8点称体重。');
  const n = calls;
  await i18n.localize('zh', txt); // now cached
  assert.equal(calls, n);
});

test('nurse translations run at temperature 0 with a deadline', async () => {
  setLang('zh');
  let body;
  reply = (opts) => ((body = JSON.parse(opts.body)), '您的体重增加了3磅。我今天下午4:30给您打电话。');
  await nurse.sendNurseMessage('p1', { text: `${SRC} Bring your pill bottles.` }); // unique text: not cached
  assert.equal(body.temperature, 0);
});

test('a name after "Hi" / "Nurse" must survive translation unchanged', () => {
  const ok = i18n.plausibleTranslation;
  assert.equal(ok('zh', 'Good morning Fresh! Please weigh yourself.', '早上好 Fresh！请称一下体重。'), true);
  assert.equal(ok('zh', 'Good morning Fresh! Please weigh yourself.', '早上好 鲜鲜！请称一下体重。'), false);
  assert.equal(ok('zh', 'Nurse Kim will call you.', '护士 Kim 会给您打电话。'), true);
  assert.equal(ok('zh', 'Nurse Kim will call you.', '护士金会给您打电话。'), false);
  assert.equal(ok('zh', 'Ask about Medicare Extra Help.', '请询问医疗保险额外帮助。'), true, 'other capitalised words may be translated');
});

test('emoji the source did not contain are rejected; the nurse\'s own emoji may stay', () => {
  const ok = i18n.plausibleTranslation;
  assert.equal(ok('tl', 'Your weight went up 3 lb.', 'Tumaas ang timbang mo ng 3 lb. 😷💪'), false);
  assert.equal(ok('tl', 'Your weight went up 3 lb. 💙', 'Tumaas ang timbang mo ng 3 lb. 💙'), true);
});

test('an unknown nurse template name such as __proto__ is a 400', async () => {
  await assert.rejects(nurse.sendNurseMessage('p1', { template: '__proto__', time: '2 PM' }), (e) => e.status === 400);
});
