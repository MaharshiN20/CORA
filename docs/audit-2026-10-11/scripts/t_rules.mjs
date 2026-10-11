process.env.LLM_PROVIDER = 'none';
process.env.HEARTBRIDGE_DB = `${process.env.TEMP}/heartbridge-lab-rules-${process.pid}.json`;
const parser = await import('file:///D:/Personal-Projects/HackGT/backend/src/core/parser.js');
const { isEmergencyText } = { isEmergencyText: (t) => { const a = parser.parseFreeText(t); return !!(a.chestPain || a.breath === 'rest' || a.fainting || a.confusion || a.otherEmergency); } };

const rows = [];
const check = (group, text, expectRed, note = '') => {
  const got = isEmergencyText(text);
  rows.push({ group, text, expectRed, got, ok: got === expectRed, note });
};

// ---- A. phrasings of a real emergency that a patient might plausibly type ----
const REAL = [
  ['plain', 'I have chest pain'], ['plain', 'my chest hurts'], ['plain', "I can't breathe"], ['plain', 'I fainted'], ['plain', 'I passed out earlier'],
  ['colloquial', 'feels like an elephant is sitting on my chest'], ['colloquial', 'my heart is pounding and my chest is tight'], ['colloquial', 'there is a crushing pain in the middle of my chest'],
  ['colloquial', 'cant catch my breath even sitting down'], ['colloquial', 'gasping for air'], ['colloquial', 'I feel like I am suffocating'], ['colloquial', 'I keep blacking out'],
  ['colloquial', 'everything went black and I hit the floor'], ['colloquial', 'dad is not making sense and keeps asking where he is'],
  ['colloquial', 'chest feels like its on fire'], ['colloquial', 'pain going down my left arm and into my jaw'], ['colloquial', 'tightness in my chest since this morning'],
  ['colloquial', 'I am so short of breath I cannot finish a sentence'], ['colloquial', 'cannot speak because I am out of breath'],
  ['typo', 'chst pain'], ['typo', 'cant brethe'], ['typo', 'i cant breath'], ['typo', 'chest paiin'], ['typo', 'faintd'], ['typo', 'chestpain'],
  ['caps', 'I CAN\'T BREATHE'], ['caps', 'CHEST PAIN!!!'], ['spacing', 'chest   pain'], ['punct', 'chest-pain'], ['punct', 'chest...pain'],
  ['spanish', 'me duele el pecho'], ['spanish', 'siento presión en el pecho'], ['spanish', 'no puedo respirar'], ['spanish', 'me estoy ahogando'], ['spanish', 'me desmayé'], ['spanish', 'mi mamá está confundida'],
  ['spanish', 'dolor fuerte en el pecho que baja por el brazo'], ['spanish', 'me falta el aire en reposo'], ['spanish', 'siento que me voy a desmayar'], ['spanish', 'se me aprieta el pecho'],
  ['spanish-no-accent', 'me desmaye'], ['spanish-no-accent', 'no puedo respirar bien y me duele el pecho'],
  ['mixed', 'tengo chest pain'], ['mixed', 'my pecho hurts'],
  ['negation-trap', 'no puedo respirar, no sé qué hacer'], ['negation-trap', "I don't know what's happening, my chest is crushing"], ['negation-trap', 'not sure why but I cant breathe'],
  ['negation-trap', 'I never felt anything like this chest pain before'], ['negation-trap', 'no pain in my legs but my chest is killing me'],
  ['embedded', 'Good morning! Slept ok, weight 172, but since lunch my chest has been really tight'], ['embedded', 'weight 170 swelling same no dizziness BUT chest pain'],
  ['embedded', 'all fine except I fainted yesterday'], ['embedded', 'tengo el peso igual pero ayer me desmayé'],
];
for (const [g, t] of REAL) check('real:' + g, t, true);

// ---- B. calm sentences that must NOT trigger 911 ----
const CALM = [
  ['negated', 'no chest pain today'], ['negated', 'no chest pain, no fainting, no confusion'], ['negated', 'sin dolor de pecho'], ['negated', 'I did not faint'], ['negated', 'nothing hurts'],
  ['idiom', 'this heat is killing me'], ['idiom', 'I am dying for a coffee'], ['idiom', 'my son gave me a heart attack with that surprise party'], ['idiom', 'that was breathtaking'], ['idiom', 'what a pain in the neck my insurance is'],
  ['other-body', 'my back hurts'], ['other-body', 'my knee pain is worse'], ['other-body', 'headache this morning'], ['other-body', 'stomach ache'],
  ['history', 'I had chest pain last year but today I feel great'], ['history', 'my husband died of a heart attack in 2015'],
  ['routine', 'I walked to the mailbox and was a little winded'], ['routine', 'slept on two pillows as usual'], ['routine', 'weight 171'], ['routine', 'took my water pill'],
  ['question', 'what should I do if I have chest pain?'], ['question', 'when should I call 911?'], ['question', 'is chest pain normal after discharge?'],
  ['pharmacy', 'the pharmacist said it might cause chest pain as a side effect'],
  ['confusion-benign', 'I am confused about which pill to take'], ['confusion-benign', 'the bill is confusing'],
  ['gratitude', 'thank you nurse'], ['gratitude', 'gracias'],
];
for (const [g, t] of CALM) check('calm:' + g, t, false);

// ---- C. evasion via unicode / formatting (a real emergency that the rules must still see) ----
const base = 'I have chest pain';
const ZW = '\u200b';
const variants = {
  'zero-width space inside word': 'I have ch' + ZW + 'est pain',
  'zero-width joiner': 'I have chest' + '\u200d' + ' pain',
  'soft hyphen': 'I have ch\u00adest pain',
  'full-width letters': 'I have ｃｈｅｓｔ ｐａｉｎ',
  'cyrillic homoglyph (е)': 'I have chеst pain',
  'non-breaking space': 'I have chest\u00a0pain',
  'tab between': 'I have chest\tpain',
  'newline between': 'I have chest\npain',
  'emoji interleaved': 'I have chest 😢 pain',
  'repeated letters': 'I have cheeeest paaaain',
  'leet': 'I have ch3st p4in',
  'dots': 'I have c.h.e.s.t p.a.i.n',
  'combining accent': 'I have che\u0301st pain',
};
for (const [k, t] of Object.entries(variants)) check('evasion', t + '', true, k);
check('evasion', 'I can\u2019t breathe', true, 'curly apostrophe');
check('evasion', 'I can\u0027t breathe', true, 'ascii apostrophe');
check('evasion', 'I cant\u200b breathe', true, 'zero-width after cant');

// ---- D. ReDoS / latency on long or pathological input ----
const timings = [];
const timeIt = (name, text) => { const t0 = performance.now(); parser.parseFreeText(text); const ms = performance.now() - t0; timings.push({ name, len: text.length, ms: Math.round(ms * 10) / 10 }); };
timeIt('100KB of "chest "', 'chest '.repeat(16000));
timeIt('100KB of "a "', 'a '.repeat(50000));
timeIt('100KB of letters no spaces', 'a'.repeat(100000));
timeIt('chest + 50k words + pain', 'chest ' + 'word '.repeat(10000) + ' pain');
timeIt('alternating chest/pain', 'chest pain '.repeat(8000));
timeIt('no puedo x 5000', 'no puedo '.repeat(5000));
timeIt('can not x 5000', "can't ".repeat(5000));
timeIt('commas x 50000', ','.repeat(50000));
timeIt('"and" x 20000', ' and '.repeat(20000));
timeIt('digits 100KB', '1'.repeat(100000));
timeIt('weight-like number soup', '172 lb '.repeat(14000));
timeIt('swollen soup', 'my feet are swollen and '.repeat(4000));
timeIt('4KB telegram-size realistic', 'I feel okay today, weight is 172 lbs, slept fine, took my pills, ankles a bit swollen. '.repeat(45));

const bad = rows.filter((r) => !r.ok);
const byGroup = {};
for (const r of rows) { const g = r.group.split(':')[0] + ':' + (r.group.split(':')[1] ?? ''); (byGroup[r.group] ??= { ok: 0, bad: 0 })[r.ok ? 'ok' : 'bad']++; }
console.log(JSON.stringify({ total: rows.length, passed: rows.filter((r) => r.ok).length, failed: bad.length }));
console.log('FAILURES (missed emergencies = MISS, false alarms = FALSE-RED):');
for (const r of bad) console.log(`  ${r.expectRed ? 'MISS     ' : 'FALSE-RED'} [${r.group}${r.note ? ' / ' + r.note : ''}] ${JSON.stringify(r.text.length > 90 ? r.text.slice(0, 90) + '…' : r.text)}`);
console.log('TIMINGS:');
for (const t of timings) console.log(`  ${String(t.ms).padStart(8)} ms  ${t.name} (${t.len} chars)`);
