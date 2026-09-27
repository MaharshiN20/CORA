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

// Orthopnea = needing MORE pillows than usual, or sleeping propped up / in a recliner.
// A bare pillow count ("my usual 2 pillows") is the patient's baseline, not a symptom.
const ORTHOPNEA =
  /\b(?:more|extra|additional|m[aá]s)\b(?:\s+\w+){0,2}\s+(?:pillows?|almohadas?)\b|\brecliner\b|\bsleep\w* (?:sitting )?up\b|\bslept (?:sitting )?up\b|\bsit(?:ting)? up to breathe?\b|\bpropped up\b|\bsill[oó]n\b|\breclinable\b|\bdorm\w* sentad[oa]\b|\bwoke up (?:short of breath|gasping|can'?t breathe)|\bme despert[eé] sin aire\b|\bsin aire en la noche\b/i;
// "Slept fine / same as usual": means no to the pillows question.
const BASELINE = /\b(?:usual|normal|same|fine|good|ok|okay|as always|like always|lo normal|como siempre|igual|bien)\b/i;

const KEYWORDS = {
  swellingWorse:
    /(more|worse|really|very|so) swol|swelling.*(worse|more)|\b(feet|foot|ankles?|legs?)\b (are |is |look |looks |feel |feels |got |getting )?(so |really |very |all )?swollen|puffy|balloons?\b|\b(shoes?|socks?|slippers?|rings?)\b.{0,20}\btight|can'?t get (my )?shoes on|hinchad[oa]s?|hinchaz[oó]n.*(peor|m[aá]s)|m[aá]s hinchad|como globos|zapatos.{0,15}apretados/i,
  swellingNone: /no swelling|not swollen|sin hinchaz[oó]n|no est[aá]n hinchad/i,
  breathExertion: /(short of breath|winded|out of breath|breathless).*(walk|stairs|moving)|(walk|stairs).*(short of breath|winded|out of breath)|me falta el aire al caminar|me canso al caminar/i,
  dizzy: /dizzy|lightheaded|mareado|mareada|mareo/i,
  yes: /^(y|yes|yeah|yep|yup|si|sí|ok|took it|i did|lo tom[eé])\b/i,
  // "Not yet" (the dose is later today) is not a missed dose.
  later: /^(not yet|later|haven'?t yet|i will|will take|todav[ií]a no|a[uú]n no|m[aá]s tarde)\b/i,
  no: /^(n|no|nah|naw|nope|forgot|missed|i didn'?t|didn'?t|olvid[eé]|no la tom[eé])\b/i,
};

// Weight in lb, or null. A number must stand alone ("2000" is not "200"): an impossible
// value is re-asked, never "corrected". Number words work too ("one sixty two").
const toLb = (n, unit) => (/^(kg|kilos?)$/i.test(unit ?? '') ? Math.round(n * 2.2046 * 10) / 10 : n);
const inRange = (lb) => lb >= 70 && lb <= 500;

export function parseWeight(text) {
  const s = String(text).replace(/(\d),(\d)/g, '$1.$2');
  const nums = [...s.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)(?![\d.]*\d)\s*(lb|lbs|pounds|libras|kg|kilos?)?\b/gi)];
  if (nums.length) {
    // First plausible number ("slept 3 nights in the recliner, 176 today" -> 176).
    for (const m of nums) {
      const lb = toLb(parseFloat(m[1]), m[2]);
      if (inRange(lb)) return lb;
    }
    return null;
  }
  const n = wordsToNumber(s);
  if (n == null) return null;
  const lb = toLb(n, /\b(kg|kilos?)\b/i.exec(s)?.[1]);
  return inRange(lb) ? lb : null;
}

// "one sixty two", "one hundred sixty-two", "two oh five", "ciento sesenta y dos" -> number.
const UNITS = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, uno: 1, un: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9 };
const TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 };
const HUNDREDS = { cien: 100, ciento: 100, doscientos: 200, trescientos: 300, cuatrocientos: 400 };
const FILLER = new Set(['y', 'and']);
const isNumberWord = (w) => w in UNITS || w in TEENS || w in TENS || w in HUNDREDS || w === 'hundred' || FILLER.has(w);

// Below 100 from at most two words ("sixty two", "oh five").
function small(ws) {
  if (!ws.length) return 0;
  if (ws.length === 1) return UNITS[ws[0]] ?? TEENS[ws[0]] ?? TENS[ws[0]] ?? null;
  if (ws.length === 2 && ws[0] in TENS && ws[1] in UNITS) return TENS[ws[0]] + UNITS[ws[1]];
  if (ws.length === 2 && ws[0] === 'oh' && ws[1] in UNITS) return UNITS[ws[1]];
  return null;
}

export function wordsToNumber(text) {
  // Longest run of number words, so "about one sixty two I think" works.
  let best = [];
  let run = [];
  for (const w of [...(norm(text).replace(/-/g, ' ').match(/[a-z]+/g) ?? []), '']) {
    if (w && isNumberWord(w)) run.push(w);
    else {
      const core = run.filter((x) => !FILLER.has(x));
      if (core.length > best.length) best = core;
      run = [];
    }
  }
  const ws = best;
  if (!ws.length) return null;
  let hundreds = 0;
  let rest = ws;
  if (ws[0] in HUNDREDS) [hundreds, rest] = [HUNDREDS[ws[0]], ws.slice(1)];
  else if (ws[0] in UNITS && ws[1] === 'hundred') [hundreds, rest] = [UNITS[ws[0]] * 100, ws.slice(2)];
  else if (ws[0] in UNITS && UNITS[ws[0]] > 0 && ws.length > 1) [hundreds, rest] = [UNITS[ws[0]] * 100, ws.slice(1)]; // "one sixty two"
  const tail = small(rest);
  return tail == null ? null : hundreds + tail;
}

export function parseSpo2(text) {
  const m = String(text).match(/(?<![\d.])(\d{2,3})(?![\d.]*\d)\s*%?/);
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
  if (hasOrthopnea(s)) a.orthopnea = true;
  if (KEYWORDS.swellingWorse.test(s)) a.swelling = 'worse';
  else if (KEYWORDS.swellingNone.test(s)) a.swelling = 'none';
  if (KEYWORDS.dizzy.test(s)) a.dizzy = true;
  return a;
}

export const isYes = (text) => KEYWORDS.yes.test(String(text).trim());
export const isLater = (text) => KEYWORDS.later.test(String(text).trim());
export const isNo = (text) => !isLater(text) && KEYWORDS.no.test(String(text).trim());

// Three or more pillows reads as propped up, unless the patient says that's their usual.
const MANY_PILLOWS = /\b(?:[3-9]|three|four|five|six|tres|cuatro|cinco|seis)\s+(?:pillows?|almohadas?)\b/;

// "extra pillows" / "the recliner" / "3 pillows", unless negated in its clause
// ("no extra pillows") or described as usual ("my usual 3 pillows").
function hasOrthopnea(text) {
  return norm(text)
    .split(CLAUSE_SPLIT)
    .some((clause) => {
      if (!clause) return false;
      const m = ORTHOPNEA.exec(clause);
      if (m) return !negated(clause, m.index);
      const many = MANY_PILLOWS.exec(clause);
      return !!many && !negated(clause, many.index) && !BASELINE.test(clause);
    });
}

// An answer to "more pillows / wake up breathless?" that means no: a plain no, or
// "nah slept fine on my usual 2 pillows".
export const isBaselineSleep = (text) => !hasOrthopnea(text) && (isNo(text) || BASELINE.test(norm(text)));

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
