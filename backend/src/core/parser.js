// Free text -> structured check-in answers.
// Regex/keyword first (offline, en + es); the LLM chain fills gaps for other phrasing/languages.
import * as llm from './llm.js';

// ---------- red flags: the phrases that mean "call 911 now" ----------
// Deterministic on purpose (this decides 911). Measured against evals/messages.jsonl
// (`npm run eval -- --no-llm`). Matching runs per clause on normalised text (lowercase,
// no accents, one apostrophe style) so that:
//   - words needn't be adjacent: "my chest has been really tight" / "me duele mucho el pecho"
//   - common typos still count: "cant breath", "chest pian"
//   - negation is scoped to its clause: "no chest pain, no dizziness" is calm, but
//     "no, I have chest pain" and "no appetite and chest pain" are not
//   - breathless only when lying down is orthopnea (YELLOW), not breathless at rest (RED)
//   - idioms don't trigger: "that bill gave me a heart attack", "confused about my meds"
const norm = (s) =>
  String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘`´]/g, "'");

const GAP = '(?:\\W+\\w+){0,4}?\\W+'; // up to 4 words in between
const near = (a, b) => new RegExp(`(?:${a})${GAP}(?:${b})|(?:${b})${GAP}(?:${a})`);

const CHEST = '\\b(?:chest|chst|pecho)\\b';
const CHEST_BAD =
  '\\b(?:pain|pains|pian|painful|tight\\w*|pressure|hurt\\w*|heav\\w*|squeez\\w*|ach\\w*|crush\\w*|burn\\w*|' +
  'dolor\\w*|duele\\w*|apretad\\w*|aprieta\\w*|presion|opresion|pesad\\w*|arde)\\b';
const BREATHLESS =
  "(?:short|out) of breath|breathless|hard to breathe?|trouble breathing|difficulty breathing|can'?t get (?:my |enough )?(?:breath|air)|" +
  'me falta (?:el )?aire|falta de aire|me cuesta respirar|sin aire|no me alcanza el aire';
const AT_REST =
  "\\b(?:sitting|sit|resting|rest|couch|sofa|chair|doing nothing|lying still|standing still|talking|" +
  'descansando|reposo|sentad[oa]|sin hacer nada|quiet[oa]|hablando)\\b';

const PATTERNS = {
  chestPain: [near(CHEST, CHEST_BAD), /\b(?:heart attack|infarto|ataque al corazon)\b/],
  breathRest: [
    /\b(?:can ?'?t|cant|cannot|can not|unable to|could ?n'?t)\s+(?:breathe?|catch (?:my )?breath)\b/,
    /\bstruggl\w* (?:to )?breathe?\b|\bgasping\b|\bchoking\b/,
    /\bno puedo respirar\b|\bme ahogo\b|\bme estoy ahogando\b|\bme asfixio\b/,
    near(BREATHLESS, AT_REST),
  ],
  fainting: [/\bfaint(?:ed|ing)?\b|\bpassed out\b|\bblacked out\b|\bdesmay\w*|\bperdi el conocimiento\b/],
  confusion: [
    /\bconfus(?:ed|ion)\b(?!\s+(?:about|by|with|over|on)\b)/,
    /\bdisoriented\b|\bdon'?t know where (?:i am|i'?m|she is|he is)\b/,
    /\bconfundid[oa]\b(?!\s+con\b)|\bno se donde estoy\b|\bno sabe donde esta\b/,
  ],
};

// Breathless *only when lying down, or waking up breathless at night (PND)* = orthopnea
// (nurse today), not breathless at rest (911).
const LYING_DOWN =
  /\b(?:lie|lay|lying|laying) (?:down|flat)\b|\blying down\b|\bflat on my back\b|\bin bed\b|\bat night\b|\b(?:woke|wake|waking) up\b|\bacostad[oa]\b|\bal acostarme\b|\ben la cama\b|\bde noche\b|\bboca arriba\b|\bme desperte\b/;
const NEGATION =
  /\b(?:no|not|never|without|denies|deny|dont|don't|didnt|didn't|havent|haven't|hasnt|hasn't|isnt|isn't|aren't|wasnt|wasn't|sin|nunca|ni|tampoco)\b/;
// Figurative "heart attack": "gave me a heart attack", "almost had a heart attack".
const IDIOM_BEFORE_HEART_ATTACK = /(?:gave|give|giving|gives|going to give)(?: me)?(?: a)?\s*$|(?:almost|nearly) (?:had|have|gave)(?: me)?(?: a)?\s*$/;
const CLAUSE_SPLIT = /[.;!?\n,]+|\b(?:but|pero|and|y|although|aunque|though|however|sino)\b/;

// Is the match at `index` in `clause` negated by a negator in the (up to) 4 words before it?
function negated(clause, index) {
  const before = clause.slice(0, index).trim().split(/\s+/).slice(-4).join(' ');
  return NEGATION.test(before);
}

function clauseFlags(clause) {
  const found = {};
  for (const [flag, regexes] of Object.entries(PATTERNS)) {
    for (const re of regexes) {
      const m = re.exec(clause);
      if (!m) continue;
      if (negated(clause, m.index)) continue;
      if (flag === 'chestPain' && /heart attack/.test(m[0]) && IDIOM_BEFORE_HEART_ATTACK.test(clause.slice(0, m.index))) continue;
      found[flag] = true;
      break;
    }
  }
  if (found.breathRest && LYING_DOWN.test(clause) && !new RegExp(AT_REST).test(clause)) {
    delete found.breathRest;
    found.orthopnea = true;
  }
  return found;
}

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

// -> { chestPain?, breathRest?, fainting?, confusion?, orthopnea? } or null.
// (orthopnea here = "can't breathe when I lie down": reported so it isn't mistaken for RED.)
export function detectRedFlags(text) {
  const found = {};
  for (const clause of norm(text).split(CLAUSE_SPLIT)) {
    if (clause?.trim()) Object.assign(found, clauseFlags(clause));
  }
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
  if (rf?.orthopnea) a.orthopnea = true; // "can't breathe when I lie down"
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
