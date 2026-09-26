// Free text -> structured check-in answers.
// Regex/keyword first (offline, en + es); the LLM chain fills gaps for other phrasing/languages.
import * as llm from './llm.js';

// Red-flag phrases we act on IMMEDIATELY, whatever step we're in.
const RED_FLAG_PATTERNS = {
  chestPain: /chest (pain|pressure|tight)|pain in (my )?chest|heart attack|dolor (de|en el) pecho|presi[oó]n en el pecho/i,
  breathRest: /can'?t breathe|cannot breathe|can'?t catch my breath|struggling to breathe|no puedo respirar|me ahogo/i,
  fainting: /faint(ed)?|passed out|blacked out|me desmay[eé]|desmayo/i,
  confusion: /confus(ed|ion)|don'?t know where i am|confundid[oa]/i,
};

const KEYWORDS = {
  swellingWorse: /(more|worse|really) swol|swelling.*(worse|more)|puffy|hinchad[oa]s?|hinchaz[oó]n.*(peor|m[aá]s)|m[aá]s hinchad/i,
  swellingNone: /no swelling|not swollen|sin hinchaz[oó]n|no est[aá]n hinchad/i,
  orthopnea: /(\d|two|three|four|dos|tres|cuatro|more|extra|m[aá]s) (pillows|almohadas)|woke up (short of breath|gasping|can'?t breathe)|me despert[eé] sin aire|sin aire en la noche/i,
  breathExertion: /(short of breath|winded|out of breath|breathless).*(walk|stairs|moving)|(walk|stairs).*(short of breath|winded|out of breath)|me falta el aire al caminar|me canso al caminar/i,
  dizzy: /dizzy|lightheaded|mareado|mareada|mareo/i,
  yes: /^(y|yes|yeah|yep|si|sí|ok|took it|i did|lo tom[eé])\b/i,
  no: /^(n|no|nope|not yet|forgot|olvid[eé]|todav[ií]a no)\b/i,
};

export function parseWeight(text) {
  const m = String(text).replace(',', '.').match(/(\d{2,3}(?:\.\d)?)\s*(lb|lbs|pounds|libras|kg)?/i);
  if (!m) return null;
  let lb = parseFloat(m[1]);
  if (m[2]?.toLowerCase() === 'kg') lb = Math.round(lb * 2.2046 * 10) / 10;
  return lb >= 70 && lb <= 500 ? lb : null;
}

export function parseSpo2(text) {
  const m = String(text).match(/\b(\d{2,3})\s*%?/);
  const n = m ? parseInt(m[1], 10) : NaN;
  return n >= 50 && n <= 100 ? n : null;
}

export function detectRedFlags(text) {
  const found = {};
  for (const [k, re] of Object.entries(RED_FLAG_PATTERNS)) if (re.test(text)) found[k] = true;
  return Object.keys(found).length ? found : null;
}

// Pull every answer we can out of one message. Returns partial answers object.
export function parseFreeText(text) {
  const a = {};
  const s = String(text);
  const rf = detectRedFlags(s);
  if (rf?.chestPain) a.chestPain = true;
  if (rf?.breathRest) a.breath = 'rest';
  if (rf?.fainting) a.fainting = true;
  if (rf?.confusion) a.confusion = true;
  if (!a.breath && KEYWORDS.breathExertion.test(s)) a.breath = 'exertion';
  if (KEYWORDS.orthopnea.test(s)) a.orthopnea = true;
  if (KEYWORDS.swellingWorse.test(s)) a.swelling = 'worse';
  else if (KEYWORDS.swellingNone.test(s)) a.swelling = 'none';
  if (KEYWORDS.dizzy.test(s)) a.dizzy = true;
  return a;
}

export const isYes = (text) => KEYWORDS.yes.test(String(text).trim());
export const isNo = (text) => KEYWORDS.no.test(String(text).trim());

// LLM fallback (Claude / Ollama / LM Studio) for phrasing or languages the keyword lists miss.
export async function parseWithLLM(text) {
  const out = await llm.completeJSON(
    'You extract heart-failure check-in answers from a patient message (any language). ' +
      'Only include fields the message clearly states. Fields: ' +
      'weightLb (number), breath ("normal"|"exertion"|"rest"), orthopnea (bool), ' +
      'swelling ("none"|"mild"|"worse"), chestPain (bool), dizzy (bool), confusion (bool), ' +
      'fainting (bool), diureticTaken (bool), spo2 (number). Also textEn: English translation.',
    text,
  );
  return out ?? null;
}
