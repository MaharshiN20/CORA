// Everyday phrasing -> clinical sign. Edit freely: this is the keyword list the
// risk LLM gets as hints (and that still reaches the nurse if the model misses it).
//
// How matching works (see normalize/matchCues below):
//   - text is lowercased, apostrophes dropped ("can't" -> "cant"), accents stripped
//     ("hinchazón" -> "hinchazon"), punctuation -> spaces, whitespace collapsed
//   - each phrase is a regex fragment matched on whole words of that normalized text
//   - a phrase preceded (within 3 words) by a negation ("no", "not", "never",
//     "didnt", "sin", "nunca"...) is ignored: "no swelling", "didnt eat chips"
//
// So write phrases lowercase, without apostrophes or accents. `\w*` handles endings
// (swell\w* = swell, swollen, swelling), `( \w+)?` allows one filler word.
// Emergencies (chest pain, can't breathe at rest, fainting) are NOT here: the rules engine owns those.

export const LEXICON = [
  {
    id: 'orthopnea',
    category: 'congestion',
    sign: 'Possible orthopnea/PND (breathless lying flat)',
    phrases: [
      // en
      'recliner', 'lazy ?boy', 'sleep\\w* (in|on) (the |my |a )?(chair|couch|sofa|armchair)',
      'sleep\\w* (sitting|propped|sat) up', 'sleep\\w* upright', 'propped up', 'prop (myself|me) up',
      '(extra|more|another|\\d|two|three|four|couple( of)?|few|bunch of|stack of) pillows', 'pillows? (under|behind) my (back|head)',
      'cant (lie|lay|sleep) (flat|down|on my back)', 'hard to (lie|lay) (flat|down)', 'lying (flat|down) (makes|is)',
      'wak\\w* up (coughing|gasping|choking|short of breath|out of breath|cant breathe|breathless|to breathe)',
      'woke (up )?(coughing|gasping|choking|short of breath|out of breath|breathless)',
      'gasping (at|in the) night', 'up at night (coughing|breathing)', '(cough|coughing|coughed) (at|all|every|in the) night',
      'night ?time cough', 'cough\\w* when i lie', 'drowning feeling', 'feel like (im )?drowning',
      // es
      'reclinable', 'sillon', 'duermo sentad\\w*', 'dormir sentad\\w*', '(mas|dos|tres|varias) almohadas',
      'no puedo acostarme', 'me despiert\\w* (sin aire|tosiendo|ahogad\\w)', 'tos (en la|de) noche',
    ],
  },
  {
    id: 'edema',
    category: 'congestion',
    sign: 'Possible worsening edema (swelling)',
    phrases: [
      // en
      '(shoes|shoe|sneakers|trainers|sandals|flip ?flops|boots|slippers|socks|sock|rings?|watch|pants|jeans|waistband|belt) (are |is |feel\\w* |getting |a bit |kinda |kind of |really |so |too )*(tight|tighter|small|dont fit|wont fit)',
      'cant (get|fit) (my )?(shoes|shoe|sneakers|boots|rings?) on', 'sock (marks|lines)', 'marks from (my )?socks',
      '(ankles?|feet|foot|legs?|calves|calf|hands?|fingers?|belly|stomach|tummy) (are |is |look\\w* |feel\\w* |getting |a bit |kinda |really |so |more )*(swollen|swole|swelled|puffy|puffed|puffier|bigger|fat|fatter|tight|huge|like balloons|heavy)',
      '(swollen|swole|puffy|puffier|fat|big) (ankles?|feet|legs?|hands?|fingers?)', 'swollen', 'swelling', 'swell\\w*( \\w+)? (up|more|worse|bad|again|back)',
      'cankles', 'water ?logged', 'retaining water', 'water retention', 'holding (on to )?(water|fluid)',
      'dent\\w* when i press', 'press(ed)? (and|it) (leaves|stays)', 'pitting',
      // es
      'hinchad\\w*', 'hinchazon', 'pies (grandes|gordos)', 'zapatos (me )?(aprietan|apretados)', 'no me (quedan|entran) los zapatos',
      'anillo (me )?aprieta', 'retengo liquido', 'retencion de (agua|liquido)',
    ],
  },
  {
    id: 'abdominal',
    category: 'congestion',
    sign: 'Possible abdominal congestion (early fullness, bloating)',
    phrases: [
      'full (so |really |too )?(fast|quick|quickly|easily)', 'fill\\w* up (so |really |too )?(fast|quick|quickly)',
      'get full', 'not (very |really |that |too |much )?hungry', 'no appetite', 'lost my appetite', 'appetite (is )?(gone|bad|down)',
      'bloat\\w*', 'belly (feels )?(tight|hard|swollen|big)', 'stomach (feels )?(tight|hard|swollen|full|big)',
      'nause\\w*', 'sick to my stomach', 'queasy', 'right side (hurts|pain|tender)',
      // es
      'sin hambre', 'no tengo hambre', 'me lleno (rapido|pronto)', 'inflamad\\w*', 'estomago (lleno|hinchado|duro)', 'nausea\\w*',
    ],
  },
  {
    id: 'urine',
    category: 'congestion',
    sign: 'Reduced urine output',
    phrases: [
      '(pee|peeing|piss|pissing|urinat\\w*|going to the bathroom|going to the toilet) (a lot |much |way )?less',
      'not (pee|peeing|urinating|going) (much|as much|a lot)', 'barely (pee|peeing|going)', 'hardly (pee|peeing|going)',
      'pill (isnt|not|doesnt|didnt) (working|make me pee)', 'water pill (isnt|not|stopped) working', 'dark (pee|urine)',
      // es
      'orino (menos|poco)', 'casi no orino', 'no he orinado',
    ],
  },
  {
    id: 'dyspnea',
    category: 'congestion',
    sign: 'More breathless with activity',
    phrases: [
      'winded', 'out of breath', 'short of breath', 'shortness of breath', 'breathless', 'huff\\w* and puff\\w*',
      'cant catch my breath', 'hard to breathe', 'harder to breathe', 'struggl\\w* to breathe', 'breathing (is )?(hard|heavy|worse)',
      'stairs (are )?(hard|harder|tough)', 'cant (do|climb|walk up) (the )?stairs', 'stop (to|and) (rest|catch)',
      'tired (walking|after walking|going)', 'wiped out', 'exhausted', 'no energy', 'so tired', 'really tired', 'weak\\w*',
      // es
      'me falta el aire', 'falta de aire', 'me canso', 'cansad\\w*', 'agotad\\w*', 'sin energia', 'me ahogo al caminar',
    ],
  },
  {
    id: 'sodium',
    category: 'diet_sodium',
    sign: 'High-sodium food or extra fluids',
    phrases: [
      'canned', 'can of', 'soup', 'ramen', 'cup noodles', 'instant noodles', 'chips', 'crisps', 'pretzels', 'crackers', 'popcorn',
      'deli', 'cold cuts', 'lunch ?meat', 'ham', 'bacon', 'sausage', 'hot ?dogs?', 'salami', 'pepperoni', 'jerky', 'spam',
      'pizza', 'burgers?', 'fries', 'fried chicken', 'fast food', 'mc ?donalds?', 'kfc', 'wendys', 'wendy is', 'burger king', 'taco bell',
      'take ?out', 'takeaway', 'drive ?thru', 'drive through', 'restaurant', 'ate out', 'eating out', 'chinese food', 'buffet',
      'frozen (dinner|meal|pizza)', 'tv dinner', 'microwave meal', 'pickles?', 'olives', 'soy sauce', 'salty', 'salted', 'added salt',
      'cheese', 'mac (and|n) cheese', 'gravy', 'bbq', 'barbecue', 'party', 'cookout', 'holiday meal', 'thanksgiving',
      'lots of (water|fluids|juice|soda|coffee|tea)', 'drinking a lot', 'so thirsty', 'really thirsty', 'watermelon',
      // es
      'sopa', 'enlatad\\w*', 'papitas', 'embutidos', 'jamon', 'tocino', 'chorizo', 'salchicha', 'comida rapida', 'tamales',
      'frijoles (de lata|refritos)', 'queso', '(mucha|con|le (pongo|puse|echo)) sal', 'salad[oa]s?', 'fiesta', 'mucha agua', 'mucho liquido',
    ],
  },
  {
    id: 'medication',
    category: 'medication',
    sign: 'Missed, stopped, or unaffordable medication',
    phrases: [
      'ran out', 'run out', 'running out', 'all out of', 'out of (my |the )?(pills?|meds|medicine|medication|water pill|lasix|furosemide)',
      'forgot (to take |my |the )?(pills?|meds|medicine|dose|water pill|lasix)', 'forgot to take', 'keep forgetting', 'missed (a |my |the )?(dose|pill|meds)',
      'skip\\w* (a |my |the )?(dose|pill|meds|water pill|lasix)', 'skip\\w* it', 'stopped (taking|the)', 'quit (taking|the)',
      'didnt take', 'havent taken', 'not taking', 'only tak\\w* (half|one)', 'half (a )?(pill|dose)', 'cut\\w* (the |my )?pills? in half',
      'too expensive', 'cost\\w* too much', 'cant afford', 'no money', 'insurance (wont|doesnt|didnt)', 'copay',
      'pharmacy (was )?(closed|didnt have)', 'couldnt (get|pick up)', 'no ride', 'cant get to the pharmacy', 'havent picked up',
      'makes me pee too much', 'side effects?', 'makes me (dizzy|sick)', 'dont like (the|that) pill',
      'which (pill|one)', 'confused (about|by) (my )?(pills|meds)', 'mixed up (my )?(pills|meds)',
      // es
      'se me acab\\w*', 'no tengo (la |las |mis )?(pastillas?|medicinas?)', 'olvid\\w* (la |las |mi |mis )?(pastillas?|medicinas?|dosis)',
      'no (me )?(la |las )?tom\\w*', 'deje de tomar', 'muy car\\w*', 'no puedo pagar', 'no tengo dinero',
    ],
  },
  {
    id: 'social',
    category: 'social',
    sign: 'Less support at home',
    phrases: [
      '(is|was|s) (away|gone|out of town|traveling|travelling|on a trip|visiting|in the hospital|sick|working (late|nights|doubles))',
      'went (away|out of town|on a trip|to visit)', 'visiting (her|his|their|my) ', 'home alone', 'by myself', 'on my own',
      'all alone', 'nobody (here|around|home|to help)', 'no one (here|around|home|to help)', 'no help', 'cant get to the store',
      'no ride', 'lonely', 'feel\\w* (kind of |kinda |a bit |a little |pretty |really |so |very )?(down|low|sad|blue|depressed|hopeless|like giving up)', 'whats the point', 'dont care anymore',
      // es
      'estoy sol[ao]', 'sola en casa', 'solo en casa', 'nadie me ayuda', 'no hay nadie', 'se fue de viaje', 'esta de viaje',
      'triste', 'deprimid\\w*',
    ],
  },
];

const NEGATIONS = new Set(['no', 'not', 'never', 'didnt', 'dont', 'doesnt', 'havent', 'hasnt', 'wasnt', 'isnt', 'arent', 'without', 'sin', 'nunca', 'nada']);

// Words that look like a negation right before the phrase but aren't, e.g. "no appetite"
// is itself the symptom. Phrases starting with a negation word skip the check.
const startsNegated = (phrase) => NEGATIONS.has(phrase.split(/[\s(\\]/)[0]);

export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/\b(\w+)['’]s\b/g, '$1 is') // "Linda's away" -> "linda is away"
    .replace(/['’`]/g, '') // cant, dont, mcdonalds
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim();
}

const COMPILED = LEXICON.map((entry) => ({
  ...entry,
  patterns: entry.phrases.map((p) => ({ re: new RegExp(`(?:^| )(?:${p})(?= |$)`, 'g'), skipNegation: startsNegated(p) })),
}));

function negated(norm, index) {
  const before = norm.slice(0, index).trim().split(' ').slice(-3);
  return before.some((w) => NEGATIONS.has(w));
}

// -> [{ id, category, sign, phrase }] one per lexicon entry that matched (first match wins).
export function matchCues(text) {
  const norm = normalize(text);
  if (!norm) return [];
  const hits = [];
  for (const entry of COMPILED) {
    for (const { re, skipNegation } of entry.patterns) {
      re.lastIndex = 0;
      let m, found = null;
      while ((m = re.exec(norm))) {
        if (skipNegation || !negated(norm, m.index)) { found = m[0].trim(); break; }
      }
      if (found) {
        hits.push({ id: entry.id, category: entry.category, sign: entry.sign, phrase: found });
        break;
      }
    }
  }
  return hits;
}
