// "Is there anything about health in this message?" Used to keep the model's free hand away from
// anything that matters: core/smalltalk.js only lets a model write a line when this says no, and
// core/companion.js does not believe a model that calls a question with these words "off-topic".
//
// Deliberately broad (English and Spanish): the body, how someone feels, mood, sleep, medicines,
// food and drink, activity, care, and the words families use for someone in trouble ("won't wake
// up", "not making sense"). A false "yes" only means the old, careful reply. This is NOT a red-flag
// rule: it never raises or lowers anything, and the emergency rules do not use it.

// Lower case, no accents, punctuation and emoji as spaces: "¿Quién eres?" -> "quien eres".
export const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[’`´]/g, "'")
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const words = (s) => s.trim().split(/\s+/);

// Whole words: short or ambiguous ones that would fire inside other words as a stem ("ill" in "illinois").
const WORDS = new Set(
  words(`
  arm arms hand hands leg legs foot feet eye eyes ear ears back lip lips hip hips rib ribs gut
  ill bad odd cold hot fall falls fell fallen falling wake wakes woke waking awake nap naps
  die dies died dying dead death alone cry cries cried crying help rest rests rested resting
  eat eats ate eating eaten tea pee peed lb lbs kg dr er test tests pulse scale move moves moving
  floor ground lying laying air lost word words wind winded pale grey gray ashen clammy
  cara boca ojo ojos mano manos pie pies piel aire tos mal mala malo frio fria peso pesa pese solo sola
  peor cita sal sed bano comer comi comio comiendo cena tomar tome tomo tomando
  cai caigo cayo caer cae caida sueno habla hablar hablando mueve mover suelo piso dr dra
`),
);

// Word starts.
const STEMS = words(`
  chest heart breath lung cough wheez chok gasp throat head face mouth tongue jaw neck shoulder finger
  ankle knee stomach belly tummy abdom skin blood bleed bled body bone muscle vision
  feel felt pain hurt ache aching sore pressure tight squeez heavy heavi dizz lighthead woozy faint
  collaps weak tired exhaust fatigue sleep slept asleep drows letharg nause vomit puk sick unwell fever
  sweat chill shak trembl shiver numb tingl swell swollen puff bloat weigh pound gain confus disorient
  forget forgot memory rememb recogni sense nonsense gibberish mumbl blur slur droop speech speak
  sad depress lonel anxi worr scare afraid fear panic stress hopeless kill suicid wors wrong strange
  weird emergenc urgent serious troubl problem unrespons unconscious respond react slump struggl
  terrif frighten tooth teeth
  medic pill tablet capsule dose dosage drug prescri refill pharmac furosemide lasix torsemide bumetanide
  carvedilol coreg metoprolol lisinopril losartan entresto spironolactone metformin inhaler oxygen
  nurse doctor clinic hospital appointment ambulance paramedic surgery result symptom diagnos treat
  therap health condition
  food meal breakfast lunch dinner snack salt sodium drink drank drunk water fluid coffee alcohol beer
  wine soup diet hungr thirst appetite sugar walk exercis stair bath shower toilet urin
  pecho corazon respir toser tosiendo ahog garganta cabeza lengua vista brazo pierna tobillo rodilla
  espalda cuello hombro estomago barriga panza sangr cuerpo hueso musculo sient senti dolor duel doli
  molest presion apret opres pesad mare desmay debil cansa agota fatiga dorm duerm despert despiert
  nausea enferm fiebre sud escalofri tembl adormec hormigue hinch inflam libra kilo confund desorient
  olvid memoria recuerd reconoc borros triste deprim ansi preocup miedo asust panico estres llor mori
  muer matar raro rara extran ayuda emergencia urgente grave problema pastilla tableta dosis receta
  farmacia furosemida inhalador oxigeno enfermer clinica ambulancia cirugia examen resultado pulso
  bascula sintoma tratamiento salud comid desayun almuerz sodio beb agua liquido cafe cerveza vino
  sopa dieta hambre apetito azucar camin ejercicio escalera descans ducha orin contest
`);

// What families write about someone in trouble without naming a body part.
const PHRASES = new RegExp(
  [
    String.raw`\b(?:pass(?:ed|ing)?|black(?:ed|ing)?|knock(?:ed)?) out\b`,
    String.raw`\b(?:throw(?:ing|n)?|threw) up\b`,
    String.raw`\bnot (?:right|myself|himself|herself|well|good|ok|okay|feeling|responding|answering|waking|making|acting|breathing|moving|talking|eating|drinking)\b`,
    String.raw`\b(?:won't|wont|will not|doesn't|doesnt|does not|don't|dont|didn't|didnt) (?:wake|answer|respond|get up|stand|speak|talk|move|see|know|recogni[sz]e|remember|understand|stop|breathe|eat|drink|make it)\b`,
    // Anything someone suddenly cannot do.
    String.raw`\b(?:can't|cant|cannot|can not|couldn't|couldnt|unable to|no puedo|no puede|no pude|no pudo)\b`,
    String.raw`\b(?:acting|talking|looks?|looking|seems?|sounds?) (?:strange|weird|odd|funny|different|off|confused|lost)\b`,
    String.raw`\bno (?:responde|despierta|contesta|reacciona|puede|puedo|sabe|reconoce|recuerda|entiende|se mueve|se levanta|habla|come|bebe)\b`,
    String.raw`\bse (?:cayo|desmayo|desplomo)\b`,
  ].join('|'),
);

export function mentionsHealth(text) {
  const s = norm(text);
  if (!s) return false;
  if (PHRASES.test(s)) return true;
  return s.split(' ').some((w) => WORDS.has(w) || w.endsWith('ache') || STEMS.some((stem) => w.startsWith(stem)));
}
