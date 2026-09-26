// Keyword lexicon: same meaning, many phrasings. Add a line here whenever you add phrases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCues, normalize } from '../src/riskllm/lexicon.js';

const ids = (text) => matchCues(text).map((h) => h.id);

const SHOULD_MATCH = {
  orthopnea: [
    'been sleeping in the recliner',
    "I've been sleeping in my chair, it's easier",
    'had to prop myself up on 3 pillows',
    'need extra pillows now',
    "can't lie flat anymore",
    'cant lay down without coughing',
    'woke up gasping last night',
    'keep waking up coughing',
    'coughing all night',
    'dormí sentada en el sillón',
    'uso dos almohadas',
  ],
  edema: [
    'shoes a bit tight',
    "my shoes don't fit",
    'cant get my shoes on',
    'my ring feels tighter',
    'ankles are puffy',
    'feet look like balloons',
    'legs swollen',
    'my feet are swole',
    'swelling is getting worse',
    'sock marks on my legs',
    'my sneakers dont fit',
    'fine. no swelling i think but my sneakers dont fit',
    'I think I am retaining water',
    'tengo los pies hinchados',
    'los zapatos me aprietan',
  ],
  abdominal: ['I get full so fast', 'not really hungry', 'no appetite today', 'feeling bloated', 'me lleno rápido'],
  urine: ["I'm peeing less", 'barely peeing even with the water pill', "water pill isn't working", 'casi no orino'],
  dyspnea: ['getting winded on the stairs', 'out of breath walking to the mailbox', 'cant catch my breath', 'so tired lately', 'me falta el aire'],
  sodium: [
    'had chicken noodle soup',
    'grabbed McDonald’s for lunch',
    'ate some chips',
    'had a ham sandwich',
    'got takeout',
    'pizza night!',
    'frozen dinner again',
    'drinking a lot of water because im so thirsty',
    'comí sopa de lata',
    'le puse mucha sal',
  ],
  medication: [
    'ran out of the water pill yesterday',
    'forgot my pills',
    'skipped the lasix so I could go out',
    'stopped taking it, makes me pee too much',
    'too expensive this month',
    "can't afford the copay",
    'only taking half a pill to make them last',
    'pharmacy didnt have it',
    'se me acabaron las pastillas',
    'olvidé mis pastillas',
  ],
  social: [
    "Linda's away this week",
    'my daughter is out of town',
    'home alone this weekend',
    'nobody here to help',
    'feeling kind of down',
    'estoy sola',
  ],
};

for (const [id, phrases] of Object.entries(SHOULD_MATCH)) {
  test(`lexicon: ${id} across phrasings`, () => {
    for (const p of phrases) assert.ok(ids(p).includes(id), `expected "${p}" -> ${id}, got [${ids(p)}]`);
  });
}

test('negation is respected', () => {
  for (const [p, id] of [
    ['no swelling today', 'edema'],
    ["didn't eat any chips", 'sodium'],
    ['not short of breath', 'dyspnea'],
    ['never forgot my pills', 'medication'],
    ['sin hinchazón', 'edema'],
  ]) assert.ok(!ids(p).includes(id), `"${p}" should NOT match ${id}`);
});

test('negation-shaped symptoms still match ("no appetite", "not hungry")', () => {
  assert.ok(ids('no appetite').includes('abdominal'));
  assert.ok(ids('not hungry at all').includes('abdominal'));
});

test('benign messages match nothing', () => {
  for (const p of ['feeling good today', 'walked the dog', 'weight 140', 'yes took it', 'Sal came by to visit', 'had a salad and fruit']) {
    assert.deepEqual(ids(p), [], `"${p}" -> [${ids(p)}]`);
  }
});

test('normalize handles apostrophes, possessives, accents, punctuation', () => {
  assert.equal(normalize("Can't  lie FLAT!!"), 'cant lie flat');
  assert.equal(normalize("Linda's away"), 'linda is away');
  assert.equal(normalize('Hinchazón'), 'hinchazon');
});
