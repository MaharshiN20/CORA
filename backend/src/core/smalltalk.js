// Small talk. "thanks", "how are you" and "who are you?" used to get "Sorry, I didn't quite catch
// that" in the middle of a check-in, and a canned "I can help with questions about your heart..."
// or a bare check-in offer outside one (2026-10-11): the model only ever filled in the form or
// picked a discharge section, it never answered the person.
//
// The three commonest ones get a fixed line from core/i18n.js: no model needed, the same answer with
// every provider. A pattern has to match the WHOLE message, so "thanks, but my chest hurts" or
// "who are you? my husband passed out" is never swallowed here, and the callers run the emergency
// rules first anyway.
// Nothing in this file touches a tier, an alert or the check-in state.
import * as store from '../store.js';
import { t } from './i18n.js';

// Lower case, no accents, punctuation and emoji as spaces: "¿Quién eres?" -> "quien eres".
const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[’`´]/g, "'")
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const HELLO = String.raw`(?:(?:hi|hello|hey|hola|good (?:morning|afternoon|evening)|buenos dias|buenas tardes|buenas noches) )?`;
const THANKS = new RegExp(
  String.raw`^(?:(?:ok|okay|oh|ah|great|perfect|good|alright|muy bien|bueno|vale) )?` +
    String.raw`(?:thank you|thanks|thank u|thx|muchas gracias|mil gracias|gracias)` +
    String.raw`(?: (?:so much|very much|a lot|again|heartbridge|for (?:asking|checking in on me|checking on me|checking in|everything|your help|the help|that|the reminder)|por (?:todo|preguntar|su ayuda|la ayuda|eso|el recordatorio)))*$`,
);
const HOW_ARE_YOU = new RegExp(
  String.raw`^${HELLO}(?:and )?(?:how are you(?: doing)?(?: today| this morning)?|how's it going|how is it going|how are things|how do you do|como estas?(?: usted)?(?: hoy)?|que tal(?: estas?)?|como le va|como te va)$`,
);
const ABOUT_PHRASE =
  String.raw`(?:who are you|what are you|who is this|who am i (?:talking|speaking|chatting) (?:to|with)|what's your name|what is your name|what (?:can|do) you do|what is this|what are you for` +
  String.raw`|are you (?:a |an )?(?:real )?(?:bot|robot|human|person|machine|computer|ai|nurse|doctor)` +
  String.raw`|quien (?:eres|es usted|es)|que eres|como te llamas|como se llama usted|que (?:puedes|puede|sabes|sabe) hacer` +
  String.raw`|(?:eres|es usted) (?:un |una )?(?:robot|bot|persona|humano|humana|maquina|enfermera|enfermero|doctor|doctora))`;
const ABOUT = new RegExp(String.raw`^${HELLO}(?:(?:sorry|excuse me|perdon|disculpe|but|pero|wait|espera) )*${ABOUT_PHRASE}(?: (?:and |y |or |o )?${ABOUT_PHRASE})*$`);

// The i18n key of the fixed line that answers this message, or null.
export function cannedKey(text) {
  const s = norm(text);
  if (!s || s.length > 80) return null;
  if (THANKS.test(s)) return 'smalltalk_thanks';
  if (HOW_ARE_YOU.test(s)) return 'smalltalk_how_are_you';
  if (ABOUT.test(s)) return 'smalltalk_about';
  return null;
}

// -> { text, textEn } or null. `lang` is the language the reply goes out in.
export function canned(patient, text, { lang = patient.language } = {}) {
  const key = cannedKey(text);
  if (!key) return null;
  store.audit('smalltalk', patient.id, { via: 'rules', key });
  return { text: t(lang, key), textEn: t('en', key) };
}
