process.env.LLM_PROVIDER = 'none';
process.env.HEARTBRIDGE_DB = `${process.env.TEMP}/heartbridge-lab-verify1-${process.pid}.json`;
const parser = await import('file:///D:/Personal-Projects/HackGT/backend/src/core/parser.js');
const red = (t) => { const a = parser.parseFreeText(t); return !!(a.chestPain || a.breath === 'rest' || a.fainting || a.confusion || a.otherEmergency) ? 'RED' : 'calm'; };

console.log('=== (a) the everyday "no X or Y" answer to the first check-in question, rules only ===');
const NEG = [
  ['en', 'No, I have no chest pain or fainting'], ['en', 'no chest pain or fainting'], ['en', 'none of those, no chest pain, no fainting'], ['en', 'nope neither chest pain nor confusion'], ['en', 'no chest pain, dizziness or fainting'], ['en', "I'm fine, no chest pain and no trouble breathing"],
  ['es', 'No, no tengo dolor de pecho ni desmayos'], ['es', 'no tengo dolor de pecho ni me he desmayado'], ['es', 'ninguno, sin dolor de pecho ni confusión'], ['es', 'no me duele el pecho ni me falta el aire'],
  ['vi', 'Không, tôi không bị đau ngực hay ngất xỉu'], ['vi', 'không đau ngực, không ngất'], ['vi', 'Không có đau ngực hoặc khó thở'], ['vi', 'tôi không bị đau ngực và cũng không bị ngất'], ['vi', 'không, tôi ổn'],
  ['hi', 'नहीं, सीने में दर्द या बेहोशी नहीं है'], ['hi', 'सीने में दर्द नहीं है'], ['hi', 'न सीने में दर्द है न बेहोशी'], ['hi', 'कोई सीने में दर्द या बेहोशी नहीं'], ['hi', 'नहीं'],
  ['zh', '没有胸痛，也没有晕倒'], ['zh', '没有胸痛或晕倒'], ['zh', '不胸痛，不晕倒'], ['zh', '我没有胸口疼痛或者昏厥'], ['zh', '没有'],
];
let falseRed = 0;
for (const [l, t] of NEG) { const r = red(t); if (r === 'RED') falseRed++; console.log(`  ${r === 'RED' ? 'FALSE-RED' : 'ok       '} [${l}] ${t}`); }
console.log(`  -> ${falseRed}/${NEG.length} calm answers treated as a 911 emergency`);

console.log('\n=== (c) which language text does the first-question "NONE" detection cover? (rules, step redflags) ===');
const checkin = await import('file:///D:/Personal-Projects/HackGT/backend/src/core/checkin.js');
console.log('exports:', Object.keys(checkin).join(', '));
