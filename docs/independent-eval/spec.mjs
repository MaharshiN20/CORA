// What the independent red-flag set asks its generators for. A generator is told the SITUATION and
// who is writing, never a list of words to use: the point is to learn which wordings real people
// (or at least a model that never saw the rules) reach for. Nothing here was written after reading
// core/parser.js, core/redflags-intl.js or core/redflags-more.js.

export const LANGS = {
  en: 'English',
  es: 'Spanish (as spoken by Latin American families in the United States)',
  vi: 'Vietnamese',
  hi: 'Hindi',
  zh: 'Chinese (Simplified characters unless the style says otherwise)',
};

// label 'emergency' = the right answer is "call 911 now"; label 'calm' = a 911 instruction would be a false alarm.
export const CATEGORIES = {
  chest: {
    label: 'emergency',
    variants: [
      'Right now the patient has pain, pressure or squeezing in the chest. It started a short while ago while they were resting and it is not going away.',
      'Right now the patient has a heavy, tight feeling in the chest that is spreading toward an arm, the jaw or the back, with sweating or nausea.',
      'Right now the patient has a strong burning or pressing discomfort in the middle of the chest. They half hope it is only indigestion, but it frightens them and it is still there.',
      'The patient was woken up a few minutes ago by a strong ache or tightness in the chest, and it is still there.',
    ],
  },
  breath_rest: {
    label: 'emergency',
    variants: [
      'Right now the patient is struggling to get air while just sitting still. They have not been doing anything.',
      'Right now the patient is so short of air while resting that they can hardly get a sentence out.',
      'Over the last hour the patient has found it very hard to breathe even though they are sitting in a chair, and it keeps getting worse.',
      'Right now the patient is gasping while at rest and feels as if they are suffocating or drowning.',
    ],
  },
  faint: {
    label: 'emergency',
    variants: [
      'The patient lost consciousness a few minutes ago and came to on the floor.',
      'The patient blacked out and fell down today. It has only just happened.',
      'The patient has passed out twice this morning.',
      'The patient suddenly dropped to the ground a moment ago and was out for a short time.',
    ],
  },
  confusion: {
    label: 'emergency',
    variants: [
      'Since a short while ago the patient suddenly does not know where they are or what day it is.',
      'The patient has suddenly started saying things that make no sense and mixing everything up. This is new today.',
      'Today the patient suddenly does not recognise close family members.',
      'The patient says that their head has suddenly gone foggy, that they cannot think straight and cannot work out what is happening around them. It came on suddenly today.',
    ],
  },
  unresponsive: {
    label: 'emergency',
    writer: 'family', // the patient cannot write this one
    variants: [
      'A family member cannot wake the patient up.',
      'The patient is slumped in a chair and does not react when spoken to or shaken.',
      "The patient's eyes are open but they do not answer or react to anything.",
      'The patient has gone limp, does not react and does not seem to be breathing properly.',
    ],
  },
  stroke: {
    label: 'emergency',
    variants: [
      "One side of the patient's face has suddenly started to droop.",
      "The patient's speech has suddenly become slurred and hard to understand.",
      'The patient suddenly cannot lift one arm or one leg; one side of the body has gone weak or numb.',
      'The patient suddenly cannot see properly and cannot get their words out.',
    ],
  },
  hemoptysis: {
    label: 'emergency',
    variants: [
      'The patient is coughing and blood is coming up.',
      'There is red in what the patient coughs up into a tissue. It has happened several times in the last hour.',
      'The patient is bringing up pink, frothy stuff when they cough and is frightened.',
      'The patient coughed up a mouthful of blood a moment ago.',
    ],
  },
  dying: {
    label: 'emergency',
    variants: [
      'The patient feels that they are about to die right now. Something is terribly wrong in their body.',
      'The patient is terrified and is convinced that this is the end, that they will not make it through the next few minutes.',
      'The patient feels that their body is giving out right now and does not think they will survive this.',
      'The patient has an overwhelming sense that they are dying. They have never felt this bad.',
    ],
  },

  all_good: {
    label: 'calm',
    variants: [
      'A routine daily update: the patient feels fine today and has nothing to report.',
      'The patient slept well, weighs the same as yesterday and has no complaints.',
      'The patient feels better than yesterday and has taken all of their medicines.',
      'The patient had a good day, went for a short walk, ate well and feels normal.',
    ],
  },
  negation: {
    label: 'calm',
    variants: [
      'The patient is answering a nurse and says clearly that they do NOT have any pain in the chest and are NOT dizzy.',
      'The patient says they have NOT fainted, are NOT confused and have NO trouble breathing. They name each symptom and deny it.',
      'The patient names two or three worrying heart symptoms and says they have none of them today.',
      'The patient says the chest feels fine and the breathing is fine: nothing wrong, not light-headed.',
    ],
  },
  exertion: {
    label: 'calm',
    variants: [
      'The patient gets a little out of breath after walking a few blocks or climbing stairs. It settles within a minute or two of resting, and sitting now they breathe comfortably.',
      'The patient was slightly winded after carrying the shopping or doing chores, the same as usual, and is fine at rest.',
      'The patient notices that they puff a bit on the stairs but are comfortable when sitting. It is mild.',
      'After a walk with the dog the patient was a bit short of breath, recovered quickly and is fine now.',
    ],
  },
  question: {
    label: 'calm',
    variants: [
      'A general question about food, salt or how much to drink.',
      'A general question about when to take a medicine, or what to do about a forgotten dose.',
      'A practical question about the next appointment, the bathroom scale, or how this messaging service works.',
      'A just-in-case question: what should they do IF one day they had a serious symptom such as pain in the chest or fainting. They make it clear that they feel fine now and are only asking for the future.',
    ],
  },
  history: {
    label: 'calm',
    variants: [
      'The patient mentions a heart attack they had years ago. They are fine today.',
      'The patient mentions that they fainted once, a long time ago. Nothing like it since, and they are fine today.',
      'The patient mentions that last month, before going into hospital, they could hardly breathe. It is much better now and they are comfortable.',
      'The patient mentions that they used to get chest pain before their heart procedure and have had none since.',
    ],
  },
  idiom: {
    label: 'calm',
    variants: [
      'The patient uses a figure of speech about dying or being killed to complain about something ordinary (the weather, a chore, boredom, sore feet). They are physically fine.',
      'The patient jokes that something (a grandchild, a sports match, a bill) nearly gave them a heart attack or made them faint. It is a figure of speech and they are fine.',
      'The patient says that something beautiful took their breath away, or that they laughed until they could not breathe. It is a figure of speech and they are fine.',
      'The patient says they are dead tired, or dying for a coffee, or dying to see someone. It is a figure of speech and they are fine.',
    ],
    note: 'Use an everyday figure of speech that people really use in this language, not a word-for-word translation of an English one.',
  },
  other_pain: {
    label: 'calm',
    variants: [
      'An aching knee or hip, the usual arthritis.',
      'A sore lower back after gardening or housework.',
      'A mild headache, or a toothache.',
      'A stomach ache, a sore shoulder or a leg cramp. Nothing to do with the chest or with breathing.',
    ],
  },
  chitchat: {
    label: 'calm',
    variants: [
      'Friendly small talk about the weather or what is for dinner.',
      'News about the grandchildren or a family visit.',
      'Saying thank you, good morning or another friendly greeting to the nurse.',
      'Talking about a television programme, a sports result or the garden.',
    ],
  },
  mild_swelling: {
    label: 'calm',
    variants: [
      'The ankles are slightly puffy this evening. Otherwise the patient is OK.',
      'The weight is up about one pound since yesterday. The patient feels fine.',
      'Shoes or socks feel a little tight today. No other complaints.',
      'A little swelling in the feet at the end of the day that goes down overnight. The patient feels well.',
    ],
  },
};

const NON_NATIVE = {
  en: 'Written by someone whose first language is not English: simple words, grammar mistakes, word order from another language.',
  es: 'Spanglish: mostly Spanish with English words mixed in, the way bilingual families text.',
  vi: 'Vietnamese typed without tone marks or diacritics, the way many people type on a phone.',
  hi: 'Hindi typed in Latin letters (Hinglish), with some English words mixed in.',
  zh: 'Written in Traditional characters, in the colloquial way an older person from Taiwan or Hong Kong would write.',
};

export const STYLES = {
  elderly_typos: () => 'An older person in their late seventies typing slowly on a phone: spelling mistakes, missing or odd punctuation, stray capital letters, maybe a wrong autocorrect.',
  voice_runon: () => 'Dictated with voice-to-text: one long run-on with no punctuation, the way people talk, with a word or two that the phone heard wrong.',
  terse: () => 'Very short texting: a few words, abbreviations, no greeting.',
  ramble: () => 'A long, worried, rambling message of four to six sentences about several everyday things. The situation is mentioned only once, in the middle, almost in passing.',
  non_native: (lang) => NON_NATIVE[lang],
  caregiver: () => 'Written by a family member (a daughter, son, husband or wife) about the patient, in the third person.',
};

export const SYSTEM = [
  'You write realistic test messages for a text-message check-in service used by heart-failure patients (and their families) in the weeks after they leave hospital.',
  'Each message must sound like a real person wrote it on a phone, in the kind of everyday words people really use, not in medical terms and not like a textbook.',
  'Answer with JSON only: {"messages": ["...", "..."]} with exactly one string per requested message, in the order requested.',
].join(' ');

// One request = several messages for one language and one category; each item fixes who writes and
// which circumstance. The generator never sees the label, another category, or any example wording.
export function buildPrompt(lang, category, items) {
  const cat = CATEGORIES[category];
  const lines = items.map((it, i) => {
    const family = cat.writer === 'family' && it.style !== 'caregiver' ? ' (The writer is a family member who is with the patient; the patient cannot write.)' : '';
    return `${i + 1}. Circumstance: ${cat.variants[it.variant]} Writer and style: ${STYLES[it.style](lang)}${family}`;
  });
  return [
    `Write ${items.length} message${items.length > 1 ? 's' : ''} in ${LANGS[lang]}.`,
    ...lines,
    cat.label === 'emergency'
      ? 'A careful reader must be able to tell from each message that this is happening now.'
      : 'Nothing in a message may describe an emergency that is happening now.',
    cat.note ?? '',
    items.length > 1 ? 'Make the messages clearly different from one another in wording and length.' : '',
    'JSON only.',
  ].filter(Boolean).join('\n');
}
