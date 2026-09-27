// Patient-facing strings. English + Spanish are built in (work offline).
// Any other language is translated by the LLM chain (Claude/Ollama/LM Studio) at send time, falling back to English.
import * as llm from './llm.js';

const STRINGS = {
  en: {
    greeting: 'Good morning {name}! 💙 Time for your daily heart check-in. It takes about a minute.',
    ask_weight: 'What is your weight this morning, in pounds? (Weigh yourself after using the bathroom, before breakfast.) Just type the number, e.g. 172',
    bad_weight: "I didn't catch a weight. Please type just the number in pounds, e.g. 172",
    ask_breath: 'How is your breathing today?',
    breath_normal: '😊 Normal',
    breath_exertion: '😮‍💨 Worse when walking',
    breath_rest: '🚨 Hard even resting',
    ask_orthopnea: 'Last night, did you need more pillows than usual or wake up short of breath?',
    ask_swelling: 'Any swelling in your feet, ankles or legs?',
    swelling_none: 'No swelling',
    swelling_mild: 'A little, same as before',
    swelling_worse: 'Worse than before',
    ask_redflags: 'Are you having any of these right now?',
    rf_chest: '💔 Chest pain / pressure',
    rf_dizzy: '😵 Dizzy / lightheaded',
    rf_confused: '🌀 Confused',
    rf_fainted: '⬇️ Fainted',
    rf_none: '✅ None of these',
    ask_diuretic: 'Did you take your water pill ({med}) today?',
    ask_spo2: 'If you have a pulse oximeter, what is your oxygen level (%)? Type the number, or tap below.',
    no_device: "I don't have one",
    yes: '✅ Yes',
    no: '❌ No',
    thanks_green: 'Thank you, {name}! Everything looks stable today. 👍',
    thanks_yellow: "Thank you, {name}. Some of your answers need a closer look, so I've asked your nurse to call you today. If you feel worse before then, call your care team.",
    red_911: '🚨 {name}, what you described can be an emergency. Please CALL 911 NOW. I have also alerted your care team and {caregiver}.',
    red_interrupt: '🚨 That sounds serious. If you have chest pain or trouble breathing, CALL 911 NOW. I have alerted your care team.',
    not_in_checkin: "Hi {name}! I'm your HeartBridge helper. Want to do your check-in now?",
    start_checkin: '▶️ Start check-in',
    advice_header: 'Tips for today:',
    advice_doing_great: 'Keep it up: take your meds, weigh yourself every morning, and keep salt low.',
    advice_low_sodium: 'Keep salt low today (under 2,000 mg). Skip canned soups, deli meats and chips.',
    advice_watch_fluids: 'Watch how much you drink. Stick to the fluid limit your doctor gave you.',
    advice_elevate_legs: 'Raise your legs on a pillow when sitting to help with swelling.',
    advice_pace_activity: 'Take breaks when walking and rest when you feel winded.',
    advice_stand_slowly: 'Stand up slowly and sit down if you feel dizzy.',
    advice_missed_dose: "You missed your water pill. Take today's dose now, but don't double up.",
    photo_received: 'Thanks for the photo! 📷 I saved it for your care team.',
    // --- channel-level strings (used by channels/*) ---
    welcome_patient: "Hi {name}! 💙 I'm HeartBridge, your heart-health helper from the hospital. I'll check in with you every day. It only takes a minute. You can answer with the buttons, by typing, or with a voice note.",
    welcome_caregiver: "Hi! 💙 You're now connected as a caregiver for {name}. You'll get an alert here if something needs attention, plus a weekly summary.",
    unknown_code: 'Welcome to HeartBridge 💙 Please open the link your care team gave you (or send /start YOURCODE).',
    help: 'I check in on your heart health every day. Use /checkin to start now, /meds to see your medicines, /language to change language, /voice for voice replies. If you have chest pain or can’t breathe, call 911.',
    language_prompt: 'Which language would you like?',
    language_set: 'Okay! I will write to you in {language} from now on.',
    voice_on: '🎙️ Voice replies are on. You can also send me voice notes.',
    voice_off: 'Voice replies are off.',
    voice_unavailable: "Sorry, I couldn't understand the voice note. Could you type your answer?",
    heard: '🎙️ I heard: "{text}"',
    file_too_large: 'That file is too big. Please send a smaller photo.',
    // --- medications (core/meds.js) ---
    med_reminder: '💊 Time for your {time} medicines:\n{list}\nTap to tell me which ones you took.',
    med_taken_label: '✅ {med}',
    med_missed_label: '❌ {med}',
    med_took_all: '✅ I took them all',
    med_logged_all: 'Great job! ✅ All logged.',
    med_logged_taken: '✅ Logged: {med} taken. Thank you!',
    med_logged_missed: 'Got it, {med} not taken today.',
    med_missed_other: "If you remember soon, take it now. If it's almost time for the next dose, skip it. Don't double up. Ask your pharmacist or nurse if you're unsure.",
    med_already: 'Already logged 👍',
  },
  es: {
    greeting: '¡Buenos días {name}! 💙 Es hora de su chequeo diario del corazón. Toma como un minuto.',
    ask_weight: '¿Cuánto pesa esta mañana, en libras? (Pésese después de ir al baño, antes del desayuno.) Escriba solo el número, ej. 172',
    bad_weight: 'No entendí el peso. Por favor escriba solo el número en libras, ej. 172',
    ask_breath: '¿Cómo está su respiración hoy?',
    breath_normal: '😊 Normal',
    breath_exertion: '😮‍💨 Peor al caminar',
    breath_rest: '🚨 Difícil aun en reposo',
    ask_orthopnea: 'Anoche, ¿necesitó más almohadas de lo normal o se despertó sin aire?',
    ask_swelling: '¿Tiene hinchazón en los pies, tobillos o piernas?',
    swelling_none: 'Sin hinchazón',
    swelling_mild: 'Un poco, igual que antes',
    swelling_worse: 'Peor que antes',
    ask_redflags: '¿Tiene alguno de estos síntomas ahora mismo?',
    rf_chest: '💔 Dolor / presión en el pecho',
    rf_dizzy: '😵 Mareo',
    rf_confused: '🌀 Confusión',
    rf_fainted: '⬇️ Se desmayó',
    rf_none: '✅ Ninguno',
    ask_diuretic: '¿Tomó hoy su pastilla para el agua ({med})?',
    ask_spo2: 'Si tiene un oxímetro, ¿cuál es su nivel de oxígeno (%)? Escriba el número o toque abajo.',
    no_device: 'No tengo',
    yes: '✅ Sí',
    no: '❌ No',
    thanks_green: '¡Gracias, {name}! Todo se ve estable hoy. 👍',
    thanks_yellow: 'Gracias, {name}. Algunas respuestas necesitan revisión, así que le pedí a su enfermera que la llame hoy. Si se siente peor antes, llame a su equipo médico.',
    red_911: '🚨 {name}, lo que describe puede ser una emergencia. Por favor LLAME AL 911 AHORA. También avisé a su equipo médico y a {caregiver}.',
    red_interrupt: '🚨 Eso suena grave. Si tiene dolor de pecho o dificultad para respirar, LLAME AL 911 AHORA. Avisé a su equipo médico.',
    not_in_checkin: '¡Hola {name}! Soy su asistente HeartBridge. ¿Quiere hacer su chequeo ahora?',
    start_checkin: '▶️ Empezar chequeo',
    advice_header: 'Consejos para hoy:',
    advice_doing_great: 'Siga así: tome sus medicinas, pésese cada mañana y coma con poca sal.',
    advice_low_sodium: 'Coma con poca sal hoy (menos de 2,000 mg). Evite sopas de lata, embutidos y papitas.',
    advice_watch_fluids: 'Cuide cuánto líquido toma. Respete el límite que le dio su doctor.',
    advice_elevate_legs: 'Suba las piernas en una almohada al sentarse para bajar la hinchazón.',
    advice_pace_activity: 'Descanse al caminar y pare cuando le falte el aire.',
    advice_stand_slowly: 'Levántese despacio y siéntese si se marea.',
    advice_missed_dose: 'Olvidó su pastilla para el agua. Tome la dosis de hoy ahora, pero no doble la dosis.',
    photo_received: '¡Gracias por la foto! 📷 La guardé para su equipo médico.',
    welcome_patient: '¡Hola {name}! 💙 Soy HeartBridge, su asistente de salud del corazón del hospital. La contactaré cada día; solo toma un minuto. Puede responder con los botones, escribiendo o con una nota de voz.',
    welcome_caregiver: '¡Hola! 💙 Ahora está conectado como cuidador de {name}. Recibirá una alerta aquí si algo necesita atención, y un resumen semanal.',
    unknown_code: 'Bienvenido a HeartBridge 💙 Por favor abra el enlace que le dio su equipo médico (o envíe /start SUCODIGO).',
    help: 'Reviso su salud del corazón cada día. Use /checkin para empezar ahora, /meds para ver sus medicinas, /language para cambiar de idioma, /voice para respuestas de voz. Si tiene dolor de pecho o no puede respirar, llame al 911.',
    language_prompt: '¿En qué idioma prefiere?',
    language_set: '¡Listo! Desde ahora le escribiré en {language}.',
    voice_on: '🎙️ Las respuestas de voz están activadas. También puede enviarme notas de voz.',
    voice_off: 'Las respuestas de voz están desactivadas.',
    voice_unavailable: 'Perdón, no pude entender la nota de voz. ¿Podría escribir su respuesta?',
    heard: '🎙️ Escuché: "{text}"',
    file_too_large: 'Ese archivo es muy grande. Por favor envíe una foto más pequeña.',
    med_reminder: '💊 Es hora de sus medicinas de las {time}:\n{list}\nToque para decirme cuáles tomó.',
    med_taken_label: '✅ {med}',
    med_missed_label: '❌ {med}',
    med_took_all: '✅ Las tomé todas',
    med_logged_all: '¡Muy bien! ✅ Todo anotado.',
    med_logged_taken: '✅ Anotado: tomó {med}. ¡Gracias!',
    med_logged_missed: 'Entendido, hoy no tomó {med}.',
    med_missed_other: 'Si se acuerda pronto, tómela ahora. Si ya casi es hora de la siguiente dosis, sáltela. No doble la dosis. Pregunte a su farmacéutico o enfermera si tiene dudas.',
    med_already: 'Ya está anotado 👍',
  },
};

const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

// Synchronous lookup: en/es natively, everything else gets English (translated later by localize()).
export function t(lang, key, vars = {}) {
  const table = STRINGS[lang] ?? STRINGS.en;
  return fill(table[key] ?? STRINGS.en[key] ?? key, vars);
}

export const hasNative = (lang) => lang in STRINGS;

const LANG_NAMES = { vi: 'Vietnamese', hi: 'Hindi', zh: 'Simplified Chinese', ko: 'Korean', fr: 'French', ar: 'Arabic', ht: 'Haitian Creole', pt: 'Portuguese', ru: 'Russian', tl: 'Tagalog' };
const cache = new Map();

// Translate an English string into the patient's language with the LLM chain (cached).
// Returns the original text if the language is native or no LLM is available.
export async function localize(lang, text) {
  if (hasNative(lang) || !llm.enabled() || !text) return text;
  const key = `${lang}:${text}`;
  if (cache.has(key)) return cache.get(key);
  const out = await llm.complete(
    `Translate the user's message into ${LANG_NAMES[lang] ?? lang} for an elderly heart-failure patient. ` +
      'Keep it simple and warm, keep emojis, numbers and "911" unchanged. Output only the translation.',
    text,
  );
  const result = out || text;
  cache.set(key, result);
  return result;
}

// Translate patient text into English for the care-team dashboard.
export async function toEnglish(lang, text) {
  if (lang === 'en' || !text) return null;
  const out = await llm.complete('Translate into English. Output only the translation.', text, 200);
  return out;
}
