// Hand-written red-flag phrases for Vietnamese, Hindi and Chinese (called from
// parser.detectRedFlags). Deterministic, no LLM: this is what still works when no model is up.
//
// Same four emergencies as the English / Spanish rules (chest pain, can't breathe / breathless
// at rest, fainted, confused) and the same safety choices:
//   - a negated symptom is calm ("không đau ngực", "सीने में दर्द नहीं है", "没有胸痛")
//   - breathless only on exertion is not an emergency; breathless only lying down or at night
//     is orthopnea (nurse today), not 911
//   - figures of speech don't trigger ("nóng muốn xỉu", "我真糊涂", "累得快晕倒了")
// Each language has its own negation: before the symptom in Vietnamese and Chinese, after it in
// Hindi ("…दर्द नहीं है"), where "नहीं जा रहा" (is NOT going away) must stay an emergency.
//
// REVIEW STATUS: read this before trusting a list. They decide a 911 instruction.
// All three were written on 2026-10-08 by a non-native author (AI-assisted) from dictionary and
// everyday-usage knowledge, and checked only against the rows in evals/messages.jsonl, which the
// same author wrote. No native speaker and no clinician has reviewed them yet. Record a review in
// REVIEW below (who, role, date, what changed); backend/test/evals.gate.test.js keeps the entry.
export const REVIEW = {
  vi: {
    reviewedBy: null,
    note: 'Typing without diacritics ("dau nguc") is matched for multi-word phrases only. Single words whose meaning depends on the tone (ngất / ngạt, xỉu / xíu, chả / cha) need the diacritics. "Heart attack" wording (đau tim, nhồi máu cơ tim) is left out: in this population it is usually history.',
  },
  hi: {
    reviewedBy: null,
    note: 'Devanagari plus a small romanised set ("seene me dard", "saans nahi aa rahi", "behosh"). "उलझन में" counts as confusion unless the sentence is about medicines or a question. दिल का दौरा / हार्ट अटैक are left out (usually history).',
  },
  zh: {
    reviewedBy: null,
    note: 'Simplified and traditional characters. 糊涂 counts as confusion except in set phrases (真糊涂, 一时糊涂, 老糊涂, 装糊涂, 难得糊涂). 心痛 / 心疼 are left out (usually emotional), as are 心梗 / 心脏病发作 (usually history).',
  },
};

// Match `src` only at token boundaries (tokens are separated by single spaces).
const tb = (src) => new RegExp(`(?<![^ ])(?:${src})(?![^ ])`, 'gu');
const tokenIndex = (str, charIndex) => (charIndex === 0 ? 0 : str.slice(0, charIndex).split(' ').length - 1);
const tokenCount = (s) => s.split(' ').length;

// Punctuation becomes a clause break ("|"), the rest is split on whitespace.
const SENTENCE_PUNCT = /[.,;:!?\n()…।॥，。！？；：、]/u;
const tokenize = (s) =>
  s
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, (m) => (SENTENCE_PUNCT.test(m) ? ' | ' : ' '))
    .trim()
    .split(/\s+/)
    .filter(Boolean);

function splitClauses(tokens, isBreak) {
  const clauses = [];
  let cur = [];
  for (let i = 0; i < tokens.length; i++) {
    const skip = tokens[i] === '|' ? 1 : isBreak(tokens, i);
    if (skip) {
      if (cur.length) clauses.push(cur);
      cur = [];
      i += skip - 1;
    } else cur.push(tokens[i]);
  }
  if (cur.length) clauses.push(cur);
  return clauses;
}

// ============================== Vietnamese ==============================
const stripVi = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');

const VI_CONJ = new Set(['nhưng', 'nhung', 'và', 'va']);
const viBreak = (t, i) => (VI_CONJ.has(t[i]) ? 1 : t[i] === 'tuy' && (t[i + 1] === 'nhiên' || t[i + 1] === 'nhien') ? 2 : 0);

// Negators. The toneless forms only count when the patient typed that word without diacritics:
// "cha" must stay "father" (chả = not), "chua" must stay sour / pagoda (chưa = not yet).
const VI_NEG = new Set(['không', 'ko', 'k', 'hông', 'hổng', 'chẳng', 'chả', 'chưa']);
const VI_NEG_PLAIN = new Set(['khong', 'ko', 'k', 'hong']);
// "không khỏe, đau ngực": the "không" belongs to the word after it, not to the symptom.
const VI_NOT_NEGATING_NEXT = new Set(['khoe', 'on', 'biet', 'hieu', 'chac', 'ngu', 'an', 'sao', 'vui', 'muon', 'duoc', 'the']);
// Between a rest word and the symptom these mean it eased or stopped: "nghỉ thì hết khó thở".
const VI_EASED = new Set(['hết', 'đỡ', 'bớt', 'giảm', 'khỏi']);

const VI = (() => {
  const BAD = 'đau|tức|nặng|thắt|nhói|ép|đè|bóp|nghẹt|rát|buốt|quặn';
  const PRE = '(?: (?:ở|vùng|bên|trong|ngay|giữa|trái|phải|tức|thắt|nhói|quặn|cả|nơi|chỗ|phía|dữ|dội))*';
  const POST = '(?: (?:tôi|em|con|mình|cháu|anh|chị|bà|ông|mẹ|bố|ba|má|cô|chú|bác|bị|đang|rất|hơi|cứ|hay|thấy|cảm|giác|quá|lại|vẫn|còn|bên|trái|phải|có|như|là|thì|cũng|của))*';
  const BREATHLESS = 'khó thở|hụt hơi|thở dốc|thở gấp|thở mệt';
  // Unmistakably at rest, and looser words that need "cũng / vẫn / mà" (even, still) after them.
  const REST = 'ngồi yên|ngồi không|ngồi im|ngồi một chỗ|nghỉ ngơi|khi nghỉ|lúc nghỉ|không làm gì|đứng yên';
  const REST_LOOSE = 'ngồi nghỉ|nằm nghỉ|đang nghỉ|đang ngồi|ngồi|nghỉ|nói chuyện';
  const STILL = 'cũng|vẫn|mà|còn';
  const BREATHLESS_P = 'kho tho|hut hoi|tho doc|tho gap';
  const REST_P = 'ngoi yen|ngoi khong|ngoi im|nghi ngoi|khi nghi|luc nghi|khong lam gi|dung yen';
  const REST_LOOSE_P = 'ngoi nghi|nam nghi|dang nghi|dang ngoi|ngoi|nghi';
  const STILL_P = 'cung|van|ma|con';
  return {
    // toned: matched on the text as typed. plain: matched on tone-stripped text, and only
    // counted when those words were typed without diacritics.
    chestPain: { toned: [tb(`(?:${BAD})${PRE} ngực`), tb(`ngực${POST} (?:${BAD}|khó chịu)`)], plain: [tb('dau(?: (?:o|vung|ben|trong|ngay|giua|trai|phai|tuc|that|nhoi))* nguc|tuc nguc|nang nguc|nhoi nguc'), tb('nguc(?: (?:toi|em|con|minh|bi|dang|rat|hoi|thay|qua|ben|trai|phai))* (?:dau|tuc)')] },
    cantBreathe: { toned: [tb('(?:không|ko|k) thở (?:được|nổi)|thở (?:không|ko|k) (?:được|nổi)|không thể thở|ngạt thở|nghẹt thở|ngộp thở|ngừng thở')], plain: [tb('(?:khong|ko|k) tho (?:duoc|noi)|tho (?:khong|ko|k) (?:duoc|noi)|khong the tho|ngat tho|nghet tho|ngop tho')] },
    breathless: { toned: [tb(BREATHLESS)], plain: [tb(BREATHLESS_P)] },
    // "even sitting still": the rest phrase comes first, or after "(ngay) cả khi / lúc".
    restBreathless: {
      toned: [
        tb(`(?:${REST})(?<gap>(?: \\S+){0,3}) (?:${BREATHLESS})`),
        tb(`(?:${REST}|${REST_LOOSE})(?<gap>(?: \\S+){0,2} (?:${STILL})(?: \\S+){0,2}) (?:${BREATHLESS})`),
        tb(`(?:${BREATHLESS})(?: \\S+){0,3} (?:khi|lúc) (?:ngồi|nghỉ|nằm nghỉ|không làm gì|đứng yên|nói chuyện)`),
      ],
      plain: [
        tb(`(?:${REST_P})(?<gap>(?: \\S+){0,3}) (?:${BREATHLESS_P})`),
        tb(`(?:${REST_P}|${REST_LOOSE_P})(?<gap>(?: \\S+){0,2} (?:${STILL_P})(?: \\S+){0,2}) (?:${BREATHLESS_P})`),
        tb(`(?:${BREATHLESS_P})(?: \\S+){0,3} (?:khi|luc) (?:ngoi|nghi|khong lam gi|dung yen)`),
      ],
    },
    fainting: { toned: [tb('ngất xỉu|ngất đi|ngất lịm|té xỉu|bất tỉnh|ngất|xỉu')], plain: [tb('ngat xiu|bat tinh|te xiu')] },
    confusion: {
      toned: [tb('lú lẫn|mê sảng|nói sảng|mất phương hướng|không nhận ra (?:ai|người|con|cháu|vợ|chồng|tôi|mình|gia đình|người nhà)|không (?:còn )?biết mình (?:đang )?ở đâu')],
      plain: [tb('lu lan|mat phuong huong|khong nhan ra (?:ai|nguoi|con|chau|vo|chong|toi|minh)|khong biet minh (?:dang )?o dau')],
    },
    exertion: /(?<![^ ])(?:đi bộ|đi lại|đi nhanh|leo|cầu thang|vận động|làm việc|gắng sức|tập|chạy|xách|di bo|di lai|leo cau thang|van dong|lam viec)(?![^ ])/u,
    lying: /(?<![^ ])(?:nằm|ban đêm|về đêm|nửa đêm|giữa đêm|thức giấc|tỉnh giấc|đang ngủ|khi nam|luc nam|nam xuong|nam ngua|ban dem|nua dem)(?![^ ])/u,
    // Not a faint: "cao ngất" (towering), "ngất ngây" (thrilled), "nóng muốn xỉu" (so hot I could faint).
    faintIdiom: /(?<![^ ])(?:cao ngất|ngất (?:ngây|ngưởng|trời)|(?:mệt|đói|nóng|cười|sợ|lạnh|khát|vui|mừng|tức|no|thèm|chán|đau)(?: (?:quá|đến|tới|mức))* muốn (?:ngất|xỉu))(?![^ ])/u,
  };
})();

// A negator in the (up to) 3 words before the match.
function viNegated(c, start) {
  const isNeg = (i) => {
    const neg = VI_NEG.has(c.toks[i]) || (c.toks[i] === c.plain[i] && VI_NEG_PLAIN.has(c.plain[i]));
    if (!neg) return false;
    return !(i + 1 < start && VI_NOT_NEGATING_NEXT.has(c.plain[i + 1]));
  };
  for (let i = Math.max(0, start - 3); i < start; i++) if (isNeg(i)) return true;
  if (start > 0 && (c.toks[start - 1] === 'hết' || (c.toks[start - 1] === 'het' && c.plain[start - 1] === 'het'))) return true; // "hết đau ngực": it has stopped
  return false;
}
// The words between a rest phrase and the symptom (the pattern's `gap` group): "ngồi yên thì
// không khó thở", "nghỉ thì hết khó thở". The rest phrase itself may contain "không" (ngồi
// không = sitting idle), which is why only the gap is looked at.
const viGapNegated = (gap) => !!gap && gap.trim().split(' ').some((w) => VI_NEG.has(w) || VI_NEG_PLAIN.has(w) || VI_EASED.has(w) || w === 'het');

function viHit(c, entry, { veto } = {}) {
  for (const [list, str, needAscii] of [[entry.toned, c.T, false], [entry.plain ?? [], c.P, true]]) {
    for (const re of list) {
      for (const m of str.matchAll(re)) {
        const start = tokenIndex(str, m.index);
        const end = start + tokenCount(m[0]);
        if (needAscii && !c.toks.slice(start, end).every((t, k) => t === c.plain[start + k])) continue;
        if (viNegated(c, start) || viGapNegated(m.groups?.gap)) continue;
        if (veto?.(start, end)) continue;
        return true;
      }
    }
  }
  return false;
}

// "không đau ngực hay ngất xỉu": the "không" scopes over the whole "or" list, so every "hay /
// hoặc" after a negator gets its own (audit 2026-10-11 S3).
const VI_OR = new Set(['hay', 'hoặc', 'hoac']);
function viDistribute(toks) {
  const out = [];
  let negSeen = false;
  toks.forEach((w, i) => {
    out.push(w);
    const isNeg = VI_NEG.has(w) || (w === stripVi(w) && VI_NEG_PLAIN.has(w));
    if (isNeg && !VI_NOT_NEGATING_NEXT.has(stripVi(toks[i + 1] ?? ''))) negSeen = true;
    else if (negSeen && VI_OR.has(w)) out.push('không');
  });
  return out;
}

function vietnamese(text) {
  const found = {};
  const tokens = tokenize(String(text).normalize('NFC').toLowerCase());
  for (const clauseToks of splitClauses(tokens, viBreak)) {
    const toks = viDistribute(clauseToks);
    const plain = toks.map(stripVi);
    const c = { toks, plain, T: toks.join(' '), P: plain.join(' ') };
    if (viHit(c, VI.chestPain)) found.chestPain = true;
    if (viHit(c, VI.confusion)) found.confusion = true;
    const idioms = [...c.T.matchAll(new RegExp(VI.faintIdiom, 'gu'))].map((m) => [tokenIndex(c.T, m.index), tokenIndex(c.T, m.index) + tokenCount(m[0])]);
    if (viHit(c, VI.fainting, { veto: (s, e) => idioms.some(([a, b]) => s >= a && e <= b) })) found.fainting = true;

    const exertion = VI.exertion.test(c.T) || VI.exertion.test(c.P);
    const lying = VI.lying.test(c.T) || VI.lying.test(c.P);
    const atRest = !exertion && viHit(c, VI.restBreathless);
    const cant = viHit(c, VI.cantBreathe);
    if (atRest || (cant && !lying)) found.breathRest = true;
    else if (lying && (cant || viHit(c, VI.breathless))) found.orthopnea = true;
  }
  return found;
}

// ============================== Chinese ==============================
// No spaces between words, so everything is substring matching inside one clause.
// (不过 is not a clause break: it is the middle of 喘不过气.)
const ZH_CLAUSE = /[，。！？；、,.!?;:：\n…]+|但是|可是|然而|只是|但/u;
// 不 / 没 that belong to another word, not to the symptom that follows.
const ZH_NOT_NEGATING =
  /不舒服|不好受|不[对對][劲勁]|不知道|不清楚|不太好|不好意思|[对對]不起|差不多|睡不[着著好]|吃不下|受不了|不得了|不行了?|了不起|不想[吃动動说說]|不敢|不小心|不久|不停|不[断斷]|不[仅僅光但管如然]|不[错錯]|[没沒]睡[好着著]|[没沒]吃[饭飯药藥]?|[没沒]力[气氣]|[没沒]精神|[没沒]胃口|[没沒]事|[没沒][办辦]法|[没沒][关關]系/gu;
const ZH_NEG_BEFORE = /(?:[没沒]有?|不是?|未曾?|[无無]|[别別]|[并並]不|[从從][没沒未]|不[会會再]|[没沒]再)[^不没沒未无無]{0,2}$/u;
const ZH_NEG_INSIDE = /[不没沒未无無]/u;
const zhClean = (s) => s.replace(ZH_NOT_NEGATING, (m) => '·'.repeat(m.length));

const ZH = (() => {
  const BREATHLESS = '喘不[过過上][气氣来來]|上不[来來][气氣]|透不[过過][气氣]|呼吸困[难難]|呼吸急促|呼吸[费費]力|[气氣]短|[气氣]喘|喘得[厉厲]害|[很好太也都还還]喘|憋[气氣]|[气氣][紧緊]';
  return {
    // 胸罩 / 胸片 / 胸围 … are not the chest as a symptom site. The gap is group 1.
    chestPain: [/(?:胸(?![罩围圍片透卡针針肌怀懷花章毛衣带帶])[口部前腔骨]?|心口|心[窝窩])(.{0,6}?)(?:痛|疼|[闷悶]|[紧緊]|[压壓]|堵|憋|[绞絞]|刺|[胀脹])/gu, /心[绞絞]痛(?!病?史|的?[药藥])/gu],
    cantBreathe: [/不能呼吸|[无無]法呼吸|[没沒](?:[办辦])?法呼吸|呼吸不了|呼吸不[过過][来來]|窒息|快要?憋死/gu],
    breathless: [new RegExp(BREATHLESS, 'gu')],
    // "even sitting / resting": the rest word comes first. The gap is group 1.
    restBreathless: [new RegExp(`(?:坐[着著在下]|休息|歇[着著]|不[动動]|[静靜]坐|安[静靜]|什[么麼]都[没沒不]做|[说說讲講][话話])(.{0,8}?)(?:${BREATHLESS})`, 'gu')],
    fainting: [/[晕暈昏]倒|[晕暈昏]了?[过過]去|昏迷|[晕暈昏]厥|失去(?:知[觉覺]|意[识識])|不省人事/gu],
    confusion: [
      // 真糊涂 / 一时糊涂 / 老糊涂 / 糊里糊涂 / 装糊涂 / 难得糊涂 / 犯糊涂 are set phrases, not delirium.
      /(?<!一[时時]|真|太|老|[里裡]|[装裝]|得|犯|小)糊[涂塗](?![账賬虫蟲蛋])/gu,
      /神[志智]不清|神志恍惚|意[识識](?:不清|模糊|混[乱亂]|障[碍礙])|精神(?:[错錯][乱亂]|混[乱亂]|恍惚)|胡言[乱亂][语語]|[说說讲講]胡[话話]/gu,
      /[认認]不(?:出|得)(?:人|我|家人|我[们們]|自己)|不[认認][识識](?:人|我|家人)|(?:家人|人|我)都(?:不[认認][识識]|[认認]不出)|不知道(?:他|她|我)?自己(?:[现現]在)?是?在(?:哪|什[么麼]地方)/gu,
    ],
    exertion: /走路|爬[楼樓]|上[楼樓]|活[动動]|[运運][动動]|[干幹]活|走[几幾]步|散步|做家[务務]|跑步/u,
    lying: /躺|平[卧臥]|睡[觉覺着著]|夜[里裡间間]|晚上|半夜|醒/u,
    // "so tired I'm about to faint" / "laughed myself silly": not a faint.
    faintIdiom: /(?:累|[饿餓]|[热熱]|忙|困)[得到]我?都?(?:快要?|要|差[点點])[晕暈昏]|(?:笑|[气氣]|美|[帅帥]|高[兴興]|[开開]心|激[动動])[得到]?我?都?(?:快要?|要)?[晕暈昏]/u,
  };
})();

function zhHit(clause, list, { intrinsic = false, veto } = {}) {
  for (const re of list) {
    for (const m of clause.matchAll(re)) {
      if (ZH_NEG_BEFORE.test(zhClean(clause.slice(0, m.index)))) continue;
      if (!intrinsic && m[1] !== undefined && ZH_NEG_INSIDE.test(zhClean(m[1]))) continue;
      if (veto?.(m)) continue;
      return true;
    }
  }
  return false;
}

// "没有胸痛或晕倒": a negator scopes over the "or / and" list that follows, so each connector after
// one is followed by its own 没有 (audit 2026-10-11 S3).
const ZH_LIST = /或者|或是|或|还是|還是|以及|及|和|跟|与|與/gu;
const ZH_ANY_NEG = /[没沒]有?|不是?|未曾?|[无無]|[别別]/u;
const zhDistribute = (c) => c.replace(ZH_LIST, (conn, off) => (ZH_ANY_NEG.test(zhClean(c.slice(0, off))) ? `${conn}没有` : conn));

function chinese(text) {
  const found = {};
  for (const raw of String(text).normalize('NFKC').toLowerCase().split(ZH_CLAUSE)) {
    const c = zhDistribute((raw ?? '').replace(/\s+/g, ''));
    if (!c) continue;
    if (zhHit(c, ZH.chestPain)) found.chestPain = true;
    if (zhHit(c, ZH.confusion, { intrinsic: true })) found.confusion = true;
    if (!ZH.faintIdiom.test(c) && zhHit(c, ZH.fainting, { intrinsic: true })) found.fainting = true;

    const exertion = ZH.exertion.test(c);
    const lying = ZH.lying.test(c);
    const atRest = !exertion && zhHit(c, ZH.restBreathless);
    const cant = !exertion && zhHit(c, ZH.cantBreathe, { intrinsic: true });
    if (atRest || (cant && !lying)) found.breathRest = true;
    else if (lying && (cant || zhHit(c, ZH.breathless, { intrinsic: true }))) found.orthopnea = true;
  }
  return found;
}

// ============================== Hindi ==============================
// One spelling per word: the nukta (ज़ -> ज), chandrabindu (साँस -> सांस) and joiners vary by keyboard.
const hiNorm = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/़/g, '')
    .replace(/ँ/g, 'ं')
    .replace(/[‌‍]/g, '')
    .normalize('NFC');
// A pattern written in ordinary Hindi, folded the same way as the text it will be matched against.
const hi = (src, flags = 'gu') => new RegExp(tb(hiNorm(src)).source, flags);

const HI_CONJ = new Set(['लेकिन', 'मगर', 'और', 'परंतु', 'किंतु']);
const hiBreak = (t, i) => (HI_CONJ.has(t[i]) ? 1 : 0);

// Hindi negates after the symptom: "दर्द नहीं है". Words that may sit in between:
const HI_AUX = 'में|मे|है|हैं|हूं|हो|होता|होती|होते|हुआ|हुई|हुए|रहा|रही|रहे|था|थी|थे|बिल्कुल|बिलकुल|तो|भी|कोई|अब|अभी|जरा|ज्यादा|कुछ|कभी|बहुत|इतना';
// ...but "दर्द नहीं जा रहा / रुक रहा / कम हो रहा" means it is NOT stopping: still an emergency.
// "दर्द या बेहोशी नहीं है": the नहीं after an "or / and" item also covers the symptom before it.
const HI_NEG_AFTER = new RegExp(hiNorm(`^(?: (?:या|और|तथा|व|अथवा)(?: \\S+){1,2})?(?: (?:${HI_AUX}))* (?:नहीं|नही|नहि|ना|न|मत)(?![^ ])(?! (?:जा|गया|गई|गए|जाता|जाती|रुक|रुका|हट|हटा|कम|ठीक|थम|छूट|मिट))`), 'u');
const HI_NEG_BEFORE = new Set(['न', 'ना', 'बिना'].map(hiNorm));
const HI_NEG_INSIDE = new RegExp(hiNorm('(?<![^ ])(?:नहीं|नही|नहि)(?![^ ])'), 'u');

const HI = (() => {
  const CHEST = 'सीने|सीना|छाती';
  const BAD = 'दर्द|जकड़न|जकड़ाहट|भारीपन|भारी|दबाव|जलन|चुभन|तकलीफ़|दुख\\S*|खिंचाव|कसाव|पीड़ा';
  const BREATHLESS = 'सांस फूल\\S*|सांस लेने में (?:तकलीफ़|दिक्कत|परेशानी|कठिनाई|मुश्किल)|सांस की (?:तकलीफ़|दिक्कत|कमी)|सांस में (?:तकलीफ़|दिक्कत)|हांफ\\S*';
  return {
    chestPain: [hi(`(?:${CHEST})(?: \\S+){0,3}? (?:${BAD})`), hi(`(?:${BAD})(?: \\S+){0,3}? (?:${CHEST})`)],
    cantBreathe: [hi('सांस(?: (?:ठीक|से|ही|भी|बिल्कुल|बिलकुल|अच्छे|ढंग)){0,3} (?:नहीं|नही) (?:आ|आती|आता|ले|ली|लिया)|दम घुट\\S*|सांस (?:रुक|बंद|अटक|थम|उखड़)\\S*')],
    breathless: [hi(BREATHLESS)],
    // "even while resting": needs भी (even), or "without doing anything".
    restBreathless: [hi(`(?:आराम|बैठे|बैठा|बैठी|बैठकर|बैठने|खाली|बात करते|बोलते)(?: \\S+){0,3} भी(?: \\S+){0,2} (?:${BREATHLESS})`), hi(`बिना कुछ किए(?: \\S+){0,2} (?:${BREATHLESS})`)],
    fainting: [hi('बेहोश\\S*|गश खा\\S*|मूर्छित|मूर्छा|चक्कर (?:खाकर|आकर) गिर\\S*')],
    confusion: [hi('उलझन में|भ्रमित')],
    // Already negative in form ("can't recognise", "doesn't know where he is").
    confusionIntrinsic: [hi('होश में (?:नहीं|नही)|होश (?:नहीं|नही)|बहकी बहकी बात\\S*|पहचान (?:नहीं|नही) (?:रहे|रहा|रही|पा\\S*)|(?:पता|मालूम)(?: ही)? (?:नहीं|नही)(?: कि)? (?:वो|वह|वे|मैं|हम|खुद|ये|यह) कहां')],
    // "confused about my medicines / the question" is not delirium.
    confusionTopic: hi('को लेकर|के बारे में|दवा\\S*|गोली\\S*|गोलियां|गोलियों|खुराक|डोज़|सवाल', 'u'),
    exertion: hi('चलने|चलते|चलता|चलती|चलकर|चलना|सीढ़ी|सीढ़ियां|सीढ़ियों|चढ़ने|चढ़ते|चढ़कर|दौड़\\S*|काम करते|काम करने|मेहनत|टहलने|टहलते', 'u'),
    lying: hi('लेटने|लेटते|लेटकर|लेटता|लेटती|लेटा|लेटी|लेट|रात में|रात को|रात के|सोते|सोने|नींद', 'u'),
  };
})();

function hiHit(c, toks, list, { intrinsic = false } = {}) {
  for (const re of list) {
    for (const m of c.matchAll(re)) {
      const start = tokenIndex(c, m.index);
      if (start > 0 && HI_NEG_BEFORE.has(toks[start - 1])) continue;
      if (!intrinsic && (HI_NEG_INSIDE.test(m[0]) || HI_NEG_AFTER.test(c.slice(m.index + m[0].length)))) continue;
      return true;
    }
  }
  return false;
}

function hindi(text) {
  const found = {};
  for (const toks of splitClauses(tokenize(hiNorm(text)), hiBreak)) {
    const c = toks.join(' ');
    if (hiHit(c, toks, HI.chestPain)) found.chestPain = true;
    if (hiHit(c, toks, HI.fainting)) found.fainting = true;
    if (hiHit(c, toks, HI.confusionIntrinsic, { intrinsic: true }) || (!HI.confusionTopic.test(c) && hiHit(c, toks, HI.confusion))) found.confusion = true;

    const exertion = HI.exertion.test(c);
    const lying = HI.lying.test(c);
    const atRest = !exertion && hiHit(c, toks, HI.restBreathless);
    const cant = !exertion && hiHit(c, toks, HI.cantBreathe, { intrinsic: true });
    if (atRest || (cant && !lying)) found.breathRest = true;
    else if (lying && (cant || hiHit(c, toks, HI.breathless))) found.orthopnea = true;
  }
  return found;
}

// Hindi typed in Latin letters, as most people text it. A small, specific set.
const HI_LATIN = {
  chestPain: /\b(?:seene|sine|seena|sina|chhati|chati|chaati|chest)\b(?:\s+\w+){0,3}?\s+(?:dard|jakdan|jakadan|bhaari(?:pan)?|bhari(?:pan)?|dabav|dabaav|jalan|dukh\w*|takleef|taklif)\b/g,
  cantBreathe: /\bsa+ns\b(?:\s+\w+){0,2}?\s+(?:nahi|nahin|nhi)\s+(?:aa|aati|aata|le|li)\b|\bdum\s+ghut\w*|\bsa+ns\s+(?:ruk|band|atak)\w*/g,
  fainting: /\bbehosh\w*/g,
  negAfter: /^(?:\s+(?:hai|h|ho|hota|hoti|hua|hui|raha|rahi|tha|thi|bilkul|to|bhi|koi|ab|abhi|kabhi))*\s+(?:nahi|nahin|nhi|nai|nahee|na|mat)\b(?!\s+(?:ja|jaa|gaya|gayi|ruk|ruka|kam|hat|theek|thik))/,
  clause: /[.,;:!?\n]+|\b(?:lekin|magar|aur)\b/,
  exertion: /\b(?:chalne|chalte|seedhi|seedhiyan|chadhne|chadhte|daudne|kaam karte)\b/,
};

function hindiLatin(text) {
  const found = {};
  for (const clause of String(text).toLowerCase().split(HI_LATIN.clause)) {
    if (!clause?.trim()) continue;
    const hit = (re, intrinsic) => [...clause.matchAll(re)].some((m) => intrinsic || !HI_LATIN.negAfter.test(clause.slice(m.index + m[0].length)));
    if (hit(HI_LATIN.chestPain)) found.chestPain = true;
    if (hit(HI_LATIN.fainting)) found.fainting = true;
    if (!HI_LATIN.exertion.test(clause) && hit(HI_LATIN.cantBreathe, true)) found.breathRest = true;
  }
  return found;
}

// Someone collapsed and will not answer / wake, or "I feel like I am dying". The clause splitters cut
// these sentences in half ("fell down" | "does not answer"), so they are matched on the whole
// message (audit 2026-10-11 S4: all of them were missed with the model on). Codes as in
// parser.OTHER_EMERGENCY: unresponsive | dying.
const COLLAPSE_WHOLE = {
  vi: {
    unresponsive: /(?:ngã|té|gục|ngất|bất tỉnh|xỉu).{0,40}(?:không (?:trả lời|phản ứng|tỉnh|dậy|thức|cử động)|kêu không|gọi không)|(?:kêu|gọi|lay) (?:mãi )?không (?:tỉnh|dậy|trả lời)|không (?:còn )?phản ứng/u,
    dying: /(?:sắp|sẽ|muốn) chết|cảm thấy mình (?:sắp )?chết/u,
  },
  hi: {
    unresponsive: new RegExp(hiNorm('(?:गिर|ढेर|बेहोश)\\S*(?: \\S+){0,6} (?:जवाब|प्रतिक्रिया|होश|हरकत|आवाज)(?: \\S+){0,2} (?:नहीं|नही)|(?:उठ|जाग) (?:नहीं|नही)|(?:नहीं|नही) (?:उठ|जाग)'), 'u'),
    dying: new RegExp(hiNorm('(?<![^ ])(?:मरने वाला|मरने वाली|मर रहा|मर रही|मर जाऊंगा|मर जाऊंगी)(?![^ ])'), 'u'),
  },
  zh: {
    unresponsive: /倒在地上|[叫喊推]不醒|昏睡不醒|[没沒]有?反[应應]|不省人事/u,
    dying: /(?<![累饿餓热熱困忙笑气氣冷渴得])我(?:觉得|感觉|覺得|感覺)?我?(?:快要?|就要|要)死(?:了|掉)/u,
  },
};

function collapseWhole(text) {
  const out = {};
  const raw = String(text);
  const s = raw.normalize('NFC').toLowerCase();
  const h = hiNorm(s.replace(/[.,;:!?।]/g, ' ').replace(/\s+/g, ' '));
  for (const [lang, codes] of Object.entries(COLLAPSE_WHOLE)) {
    for (const [code, re] of Object.entries(codes)) {
      const subject = lang === 'hi' ? h : lang === 'zh' ? raw.normalize('NFKC') : s;
      if (re.test(subject)) out.otherEmergency ??= code;
    }
  }
  return out;
}

// -> { chestPain?, breathRest?, fainting?, confusion?, orthopnea?, otherEmergency? } (empty when nothing matched).
// Each language only runs when its script (or, for Latin-script input, its words) can be there.
export function detectIntlRedFlags(text) {
  const s = String(text ?? '');
  const found = {};
  if (/[ऀ-ॿ]/.test(s)) Object.assign(found, hindi(s));
  if (/[㐀-鿿]/.test(s)) Object.assign(found, chinese(s));
  if (/\p{Script=Latin}/u.test(s)) Object.assign(found, vietnamese(s), hindiLatin(s));
  Object.assign(found, collapseWhole(s));
  return found;
}
