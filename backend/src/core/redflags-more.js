// Hand-written red-flag phrases for Korean, Arabic, Portuguese, Tagalog and Haitian Creole: the five
// offered languages that had NO deterministic rules (audit 2026-10-11 S4: their emergency handling was
// a 7B model alone). Same four emergencies as the other lists (chest pain, can't breathe, fainting,
// confusion) plus collapsed / not responding and "I am dying". Rules only, no LLM: this is what still
// works when no model is up, and it runs next to the model second opinion, never instead of it.
//
// REVIEW STATUS: read this before trusting a list. They decide a 911 instruction.
// Written on 2026-10-11 by a non-native author (AI-assisted) from dictionary and everyday-usage
// knowledge, and checked only against the phrases in backend/test/redflags.more.test.js, which the
// same author wrote. No native speaker and no clinician has reviewed them. Record a review in
// REVIEW below (who, role, date, what changed).
//
// Deliberate choices: a negated symptom is calm ("가슴이 안 아파요", "não tenho dor no peito"); breathless
// only counts when it says rest / "can't breathe" outright; figures of speech are not handled (rare
// in short symptom messages), so these lists lean towards raising the alarm.
export const REVIEW = {
  ko: { reviewedBy: null, note: 'Negation is looked for after the symptom (없/않/안/아니). 정신이 없다 (busy) is deliberately not confusion.' },
  ar: { reviewedBy: null, note: 'Modern Standard plus common Gulf / Levantine / Egyptian spellings of التنفس / ألم الصدر. Negators are looked for in the 3 words before the symptom.' },
  pt: { reviewedBy: null, note: 'Brazilian and European spellings, with and without accents.' },
  tl: { reviewedBy: null, note: 'Tagalog with common English code-switching ("chest pain" is caught by the English rules).' },
  ht: { reviewedBy: null, note: 'Haitian Creole spellings vary a lot; only the most common ones are listed.' },
};

const strip = (s) => s.normalize('NFKC').toLowerCase();
const noAccents = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

// Each language: patterns (regex source strings are fine: all flags are 'iu'), the negators that
// scope over the symptom after them / before them, and a clause splitter.
const LANGS = {
  ko: {
    script: /[가-힣]/u,
    clause: /[.,;!?\n。]+|(?:그런데|하지만|그리고|근데|그러나)/u,
    chest: [/(?:가슴|흉부)\S{0,3}\s*(?:\S{0,6}\s*)?(?:아프|아파|아픕|통증|답답|조이|조여|눌리|눌려|짓눌|쥐어|압박|쑤시|쑤셔|찌릿|뻐근)/u, /(?:가슴|흉부)\s*(?:이|가|을|를)?\s*(?:쥐어짜|쥐어짜는|터질|터지)/u],
    cant: [/숨\s*(?:을|이|도)?\s*(?:못|안)\s*(?:쉬|쉴|쉬어)/u, /숨\s*쉬기\s*(?:가\s*)?(?:힘들|어렵|곤란)/u, /숨\s*(?:이|을)?\s*(?:막히|막혀|막힌|막혀서)/u, /호흡\s*곤란/u, /질식/u, /숨\s*(?:이|을)?\s*(?:쉬어지지|쉬지지)\s*않/u],
    faint: [/기절/u, /쓰러(?:졌|지|짐|질|져|진|져서|졌어)/u, /실신/u, /(?:의식|정신)\s*(?:을|이)?\s*(?:잃|읽)/u],
    confused: [/혼란스러|횡설수설|헛소리|알아보지\s*못|어디(?:인지|에\s*있는지)\s*모르|여기가\s*어디/u],
    unresp: [/(?:쓰러|넘어).{0,20}(?:반응|대답|말)\s*(?:이|을)?\s*(?:없|안|못)/u, /깨워도\s*(?:안|못)/u, /(?:의식|반응)\s*(?:이)?\s*없/u, /대답\s*(?:을|도)?\s*(?:안|못)\s*(?:해|하)/u, /깨어나지\s*(?:않|못)/u],
    dying: [/죽을\s*것\s*같/u, /죽을\s*(?:거|것)\s*같/u, /죽겠/u],
    negBefore: null,
    negInside: /(?:^|\s)안\s|않|없/u,
    negAfter: /^[^.,;!?\n]{0,14}?(?:없(?:어|다|습니다|네|는)|안\s*(?:아|쑤|답답|조이)|않|아니(?:에요|요|야|다)|괜찮)/u,
    intrinsicFaint: [/의식\s*(?:을|이)?\s*(?:잃|없)/u],
  },
  ar: {
    script: /[ء-ي]/u,
    clause: /[.,;!?\n،؛؟]+|(?:لكن|ولكن|بس)/u,
    chest: [/(?:ألم|الم|وجع|ضغط|ضيق|انقباض|ثقل|حرقان|حرقة)\s+(?:في|فى|على|ب)?\s*(?:ال)?صدر/u, /صدر(?:ي|ها|ه)?\s+(?:يؤلم|يوجع|يضغط|مثقل|ضيق|ينقبض|يحرق|يألم)/u, /(?:ال)?صدر(?:ي)?\s+(?:بيوجع|بيوجعني|بيألمني)/u],
    cant: [/لا\s+(?:أستطيع|استطيع|أقدر|اقدر|أقدر|اقدر)\s+(?:ال)?تنفس/u, /ما\s+(?:أقدر|اقدر|أقدر|أستطيع)\s+(?:ال)?تنفس|مش\s+قادر\s+أتنفس|مو\s+قادر\s+أتنفس/u, /(?:أ|ا)ختنق|اختناق|مختنق/u, /انقطع\s+(?:ال)?نفس/u, /(?:صعوبة|ضيق)\s+(?:في|فى)?\s*(?:ال)?تنفس.{0,25}(?:وأنا\s+(?:جالس|جالسة|مرتاح|مرتاحة|ساكن)|حتى\s+(?:وأنا\s+)?(?:جالس|جالسة)|في\s+الراحة|أثناء\s+الراحة|وقت\s+الراحة)/u],
    faint: [/(?:إ|ا)غماء|أغمي|اغمي|مغمى|مغشي|فقد(?:ت|ان|)?\s+(?:ال)?وعي|فقدت\s+الوعي|أغمى/u, /(?:سقط|وقع|وقعت|سقطت).{0,12}(?:على\s+الأرض|ع\s+الارض)/u],
    confused: [/ارتباك|مشوش|مشوّش|هذيان|يهذي|تهذي|لا\s+(?:يعرف|تعرف)\s+(?:أين|وين|اين)|لا\s+(?:يتعرف|تتعرف)\s+على/u],
    unresp: [/لا\s+(?:يستجيب|تستجيب|يستيقظ|تستيقظ|يرد|ترد|يتحرك|تتحرك)/u, /غائب(?:ة)?\s+عن\s+الوعي|فاقد(?:ة)?\s+الوعي/u, /ما\s+(?:يرد|يستجيب|يصحى)/u],
    dying: [/(?:سأ|سا)موت|راح\s+أموت|بموت|أشعر\s+أنني\s+(?:سأ|سا)موت/u],
    negBefore: /(?:^|\s)(?:لا|ليس|ليست|بدون|بلا|ما|مافي|ما\s+في|مش|مو|من\s+غير)(?:\s+\S+){0,2}\s*$/u,
    negAfter: null,
    intrinsicFaint: [/فقد(?:ت|ان)?\s+(?:ال)?وعي/u],
  },
  pt: {
    script: /\p{Script=Latin}/u,
    clause: /[.,;!?\n]+|\b(?:mas|porém|porem|e)\b/u,
    chest: [
      /\b(?:dor|dores|pressao|pressão|aperto|peso|queimacao|queimação|facada|pontada)\s+(?:\p{L}+\s+){0,3}?(?:no|do|em|na|de)\s+(?:meio\s+do\s+)?peito\b/u,
      /\bpeito\b\s+(?:\p{L}+\s+){0,2}?(?:doi|doendo|di|dói|apertad[oa]|apertando|pesad[oa]|queimando|pegando fogo|esmagando)/u,
      /\b(?:coracao|coração)\b.{0,20}\b(?:sair|saindo)\b.{0,12}\bpeito\b/u,
    ],
    cant: [/\bnao consigo respirar\b/u, /\bnão consigo respirar\b/u, /\b(?:falta de ar|sem ar)\b.{0,25}\b(?:parado|parada|sentado|sentada|em repouso|repouso|descansando|deitado)\b/u, /\bsufoc\p{L}*/u, /\b(?:dificuldade|dificil|difícil|custa|custando)\s+(?:para|de|a)?\s*respirar\b.{0,25}\b(?:parado|parada|sentado|sentada|repouso|descansando)\b/u, /\bnao (?:consigo|estou conseguindo) (?:pegar|tomar) ar\b/u, /\bnão (?:consigo|estou conseguindo) (?:pegar|tomar) ar\b/u, /\bfaltando ar\b.{0,12}\bmuito\b/u],
    faint: [/\bdesmai\p{L}*/u, /\b(?:apag(?:uei|ou|ando)|perdeu os sentidos|perdi os sentidos|perdi a consciencia|perdi a consciência|perdeu a consciencia|perdeu a consciência)\b/u, /\bquase (?:desmaiando|desmaiei)\b/u],
    confused: [/\bconfus[oa]\b(?!\s+(?:com|sobre|quanto))/u, /\bdesorientad[oa]\b/u, /\bnao sabe onde (?:esta|está)\b|\bnão sabe onde (?:está|estou)\b|\bnao sei onde estou\b|\bnão sei onde estou\b/u, /\bfalando (?:coisa com coisa|besteira|bobagem)\b|\bdeliran\p{L}+/u],
    unresp: [/\b(?:caiu|desabou|despencou|cai)\b.{0,25}\bnao (?:responde|acorda|reage|fala)\b/u, /\b(?:caiu|desabou|despencou|cai)\b.{0,25}\bnão (?:responde|acorda|reage|fala)\b/u, /\bnao (?:responde|acorda|reage)\b/u, /\bnão (?:responde|acorda|reage)\b/u, /\binconsciente\b|\bsem (?:pulso|respirar)\b|\bnao esta respirando\b|\bnão está respirando\b/u],
    dying: [/\b(?:vou|vai) morrer\b|\bestou morrendo\b|\bacho que vou morrer\b|\bsinto que vou morrer\b/u],
    negBefore: /(?:^|\s)(?:nao|não|nenhum|nenhuma|sem|nunca|nem|ninguem)(?:\s+\S+){0,3}\s*$/u,
    negAfter: null,
    intrinsicFaint: [],
  },
  tl: {
    script: /\p{Script=Latin}/u,
    clause: /[.,;!?\n]+|\b(?:pero|ngunit|at)\b/u,
    chest: [/\b(?:sakit|kirot|bigat|hapdi|sikip|hirap|bigat)\s+(?:sa|ng)\s+(?:aking\s+|ang\s+)?dibdib\b/u, /\bmasakit\s+(?:ang|ung|yung)\s+(?:aking\s+)?dibdib\b/u, /\bdibdib\b\s+(?:ko\s+)?(?:\p{L}+\s+){0,2}?(?:masakit|sumasakit|mabigat|sumisikip|kumikirot|nasusunog|nanghihina|parang\s+(?:may\s+)?(?:nakadagan|pinipiga))/u, /\bnakadagan\b.{0,20}\bdibdib\b/u],
    cant: [/\bhindi\s+(?:ako\s+)?(?:makahinga|makahinga)\b/u, /\b(?:hirap|nahihirapan)\s+(?:akong\s+|ako\s+|na\s+)?(?:huminga|paghinga)\b.{0,25}\b(?:kahit|nakaupo|nagpapahinga|pahinga)\b/u, /\bnasasakal\b|\bhindi\s+makahinga\b|\bwalang\s+hangin\b/u, /\bhinihingal\b.{0,20}\b(?:kahit|nakaupo|nagpapahinga)\b/u],
    faint: [/\bnahimatay\b|\bhimatay\b|\bnawalan\s+(?:ng\s+)?(?:malay|ulirat|\p{L}+\s+malay)\b|\bbumagsak\b.{0,15}\b(?:walang\s+malay|hindi\s+gumagalaw)\b|\bmahihimatay\b/u],
    confused: [/\blito(?:ng-lito)?\b|\bnaguguluhan\b|\bhindi\s+alam\s+kung\s+nasaan\b|\bnagdedeliryo\b|\bkung\s+ano-ano\s+ang\s+sinasabi\b|\bhindi\s+(?:ako\s+)?kilala\b/u],
    unresp: [/\bhindi\s+(?:na\s+)?(?:sumasagot|gumagalaw|nagigising|tumutugon|humihinga)\b/u, /\bwalang\s+malay\b|\bwalang\s+tugon\b/u, /\bbumagsak\b.{0,25}\bhindi\s+(?:na\s+)?(?:sumasagot|gumagalaw|nagigising)\b/u],
    dying: [/\bmamamatay\s+na\s+(?:ako|yata)\b|\bparang\s+mamamatay\b|\bmamamatay\s+ako\b/u],
    negBefore: /(?:^|\s)(?:walang|wala|hindi|di|hindi\s+naman|wala\s+naman|ni)(?:\s+\S+){0,3}\s*$/u,
    negAfter: /^\s*(?:ko\s+)?(?:naman\s+)?(?:\p{L}+\s+)?(?:hindi|wala|walang)\b/u,
    intrinsicFaint: [],
  },
  ht: {
    script: /\p{Script=Latin}/u,
    clause: /[.,;!?\n]+|\b(?:men|e|epi)\b/u,
    chest: [/\b(?:doul[eè]|mal|presyon|lou|sere|bat|kouto)\s+(?:\p{L}+\s+){0,2}?(?:nan|sou|anba)?\s*pwatr[iy]n\b/u, /\bpwatr[iy]n\b\s+(?:mwen\s+|m\s+)?(?:\p{L}+\s+){0,2}?(?:fè mal|fe mal|sere|lou|ap boule|ap fè mal|ap fe mal|pike|kouto)/u, /\bm(?:wen)?\s+gen\s+(?:yon\s+)?(?:gwo\s+)?(?:doul[eè]|presyon)\s+(?:nan|sou)\s+(?:kè|ke|pwatr[iy]n)\b/u],
    cant: [/\b(?:m|mwen)\s+pa\s+ka\s+(?:respire|souf[ly]e)\b/u, /\bpa\s+ka\s+respire\b/u, /\b(?:m|mwen)\s+(?:ap\s+)?(?:toufe|toufe)\b|\btoufe\b/u, /\bdifikilte\s+(?:pou\s+)?respire\b.{0,25}\b(?:chita|repo|poze)\b/u, /\bm\s+pa\s+jwenn\s+lè\b|\bmwen\s+pa\s+jwenn\s+l[eè]\b/u, /\bsouf\s+(?:mwen|m)\s+(?:koupe|kout)\b.{0,25}\b(?:chita|repo|poze|menm)\b/u, /\bpèdi\s+souf\b|\bpedi\s+souf\b/u],
    faint: [/\b(?:svan(?:i|wi)|svannwi|endispoze|dekonnen|tonbe\s+(?:sanzatann|san\s+konesans|nan\s+konesans)|p[eè]di\s+konesans|pedi\s+konesans)\b/u],
    confused: [/\bkonfi(?:ze|s)?\b|\bli\s+pa\s+konnen\s+ki\s+kote\s+li\s+ye\b|\bm\s+pa\s+konnen\s+ki\s+kote\s+m\s+ye\b|\bdeliran\b|\bpale\s+san\s+sans\b|\bpa\s+rekonèt|\bpa\s+rekonet/u],
    unresp: [/\b(?:li\s+)?(?:pa|p)\s+(?:reponn|reveye|bouje|reaji)\b/u, /\bsan\s+konesans\b|\binkonsyan\b/u, /\btonbe\b.{0,25}\b(?:pa|p)\s+(?:reponn|reveye|bouje)\b/u],
    dying: [/\bm\s*(?:ap|pral)\s+mouri\b|\bmwen\s+(?:ap|pral)\s+mouri\b|\bmouri\s+m\b/u],
    negBefore: /(?:^|\s)(?:pa|p|pa\s+gen|san|okenn|anyen|ni)(?:\s+\S+){0,2}\s*$/u,
    negAfter: null,
    intrinsicFaint: [],
  },
};

function hits(cfg, regexes, clause, { intrinsic = false } = {}) {
  for (const re of regexes) {
    const g = new RegExp(re.source, 'gu');
    for (const m of clause.matchAll(g)) {
      if (!intrinsic) {
        if (cfg.negInside?.test(m[0])) continue;
        if (cfg.negBefore && cfg.negBefore.test(clause.slice(0, m.index))) continue;
        if (cfg.negAfter && cfg.negAfter.test(clause.slice(m.index + m[0].length))) continue;
      }
      return true;
    }
  }
  return false;
}

// Languages that share the Latin script are only tried when one of their own marker words is there,
// so an English or Spanish sentence never goes through them.
const LATIN_MARKERS = {
  pt: /\b(?:não|nao|vou|acho|morrer|morrendo|peito|desmai\w*|respirar|socorro|estou|tenho|minha|meu|caiu|acorda|sufoc\w*)\b/u,
  tl: /\b(?:lito|litong|nanay|tatay|bumagsak|dibdib|hindi|makahinga|huminga|nahimatay|walang|hinihingal|masakit|ako|ko|mamamatay|sumasagot)\b/u,
  ht: /\b(?:pwatr[iy]n|mwen|m\s+pa|toufe|respire|svan\w*|doul[eè]|konesans|reponn|mouri)\b/u,
};

// -> { chestPain?, breathRest?, fainting?, confusion?, otherEmergency? } (empty when nothing matched).
export function detectMoreRedFlags(text) {
  const raw = strip(String(text ?? ''));
  const found = {};
  for (const [lang, cfg] of Object.entries(LANGS)) {
    if (!cfg.script.test(raw)) continue;
    const latin = lang === 'pt' || lang === 'tl' || lang === 'ht';
    if (latin && !LATIN_MARKERS[lang].test(raw) && !LATIN_MARKERS[lang].test(noAccents(raw))) continue;
    // Whole-message patterns first (a clause splitter cuts "fell and does not answer" in half).
    if (hits(cfg, cfg.unresp, raw, { intrinsic: true })) found.otherEmergency ??= 'unresponsive';
    if (hits(cfg, cfg.dying, raw, { intrinsic: true })) found.otherEmergency ??= 'dying';
    for (const clause of raw.split(cfg.clause)) {
      const c = (clause ?? '').trim();
      if (!c) continue;
      if (hits(cfg, cfg.chest, c)) found.chestPain = true;
      if (hits(cfg, cfg.cant, c, { intrinsic: true })) found.breathRest = true;
      if (hits(cfg, cfg.faint, c) || hits(cfg, cfg.intrinsicFaint, c, { intrinsic: true })) found.fainting = true;
      if (hits(cfg, cfg.confused, c)) found.confusion = true;
    }
  }
  return found;
}
