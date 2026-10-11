// S3 (audit 2026-10-11): the calm answer to "are you having any of these right now?" must not be
// a 911, and a question about / history of chest pain must not lock a patient out. The guards
// below keep the real emergencies that look similar.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLM_PROVIDER = 'none';
const parser = await import('../src/core/parser.js');
const red = (t) => {
  const a = parser.parseFreeText(t);
  return !!(a.chestPain || a.breath === 'rest' || a.fainting || a.confusion || a.otherEmergency);
};

const CALM = [
  'No, I have no chest pain or fainting', 'no chest pain or fainting', 'none of those, no chest pain, no fainting',
  'nope neither chest pain nor confusion', 'no chest pain, dizziness or fainting', "I'm fine, no chest pain and no trouble breathing",
  'no chest pain, dizziness, and fainting', 'without chest pain or fainting',
  'No, no tengo dolor de pecho ni desmayos', 'no tengo dolor de pecho ni me he desmayado', 'ninguno, sin dolor de pecho ni confusión',
  'no me duele el pecho ni me falta el aire', 'sin dolor de pecho ni mareos o desmayos',
  'Không, tôi không bị đau ngực hay ngất xỉu', 'không đau ngực, không ngất', 'Không có đau ngực hoặc khó thở', 'tôi không bị đau ngực và cũng không bị ngất',
  'नहीं, सीने में दर्द या बेहोशी नहीं है', 'सीने में दर्द नहीं है', 'न सीने में दर्द है न बेहोशी', 'कोई सीने में दर्द या बेहोशी नहीं',
  '没有胸痛，也没有晕倒', '没有胸痛或晕倒', '不胸痛，不晕倒', '我没有胸口疼痛或者昏厥',
  // questions, hypotheticals, history
  'what should I do if I have chest pain?', 'is chest pain normal after discharge?', 'the pharmacist said it might cause chest pain as a side effect',
  'I had chest pain last year but today I feel great', 'I had chest pain two years ago', 'qué hago si tengo dolor de pecho?',
];
for (const text of CALM) test(`calm: ${text}`, () => assert.equal(red(text), false));

const EMERGENCY = [
  'chest pain', 'I have chest pain', 'no dizziness, but chest pain', 'no chest pain, I feel like I am fainting', 'I have no chest pain, but I fainted',
  'my chest hurts or I faint', 'chest pain and fainting', 'is it normal that my chest hurts so bad right now?', 'Is it normal to have chest pain after walking?',
  'what do I do, my chest hurts right now', 'I had chest pain last night', 'no appetite, chest pain',
  'tengo dolor de pecho', 'me duele el pecho y me desmayé',
  'đau ngực', 'không khỏe, đau ngực hay ngất xỉu', 'सीने में दर्द है', 'सीने में दर्द है या सांस नहीं आ रही', 'सीने में दर्द नहीं जा रहा',
  '胸痛', '胸痛或晕倒', '我没睡好，胸痛',
];
for (const text of EMERGENCY) test(`still an emergency: ${text}`, () => assert.equal(red(text), true));

test('a negated list does not hide a symptom reported in the same breath', () => {
  const a = parser.parseFreeText('no chest pain, no fainting, but my legs are very swollen and I feel dizzy');
  assert.equal(a.dizzy, true);
  assert.equal(a.swelling, 'worse');
  assert.ok(!a.chestPain && !a.fainting);
});

test('distributeNegation: only bare list items are negated', () => {
  const d = parser.distributeNegation;
  assert.equal(d('no chest pain, dizziness or fainting'), 'no chest pain, no dizziness or no fainting');
  assert.equal(d('no chest pain, i feel dizzy'), 'no chest pain, i feel dizzy');
  assert.equal(d('i feel dizzy or faint'), 'i feel dizzy or faint');
});
