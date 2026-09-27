// Patient-facing strings. English + Spanish are hand-written (work offline).
// Other languages: machine-translated templates from `npm run i18n:build` (src/core/i18n-generated,
// offline, flagged needsReview) first, then the LLM chain at send time, then English.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as llm from './llm.js';

const STRINGS = {
  en: {
    greeting: 'Good morning {name}! 💙 Time for your daily heart check-in: a few quick questions, most are one tap.',
    ask_weight: 'What is your weight this morning, in pounds? (Weigh yourself after using the bathroom, before breakfast.) Just type the number, e.g. 172',
    bad_weight: "I didn't catch a weight. Please type just the number in pounds, e.g. 172",
    weight_confirm_up: "That's {diff} lb more than your last weight ({last} lb). Is {lb} lb right?",
    weight_confirm_down: "That's {diff} lb less than your last weight ({last} lb). Is {lb} lb right?",
    weight_confirm_yes: '✅ Yes, {lb} lb is right',
    weight_confirm_no: '✏️ Let me re-enter it',
    ask_breath: 'How is your breathing today?',
    breath_normal: '😊 Normal',
    breath_exertion: '😮‍💨 Worse when walking',
    breath_rest: '🚨 Hard even resting',
    ask_orthopnea: 'How did you sleep last night?',
    orth_pillows: '🛏️ Needed more pillows than usual / slept sitting up',
    orth_pnd: '😮‍💨 Woke up short of breath',
    orth_none: '😴 Slept as usual',
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
    ask_diuretic: 'Have you taken your water pill ({med}) today?',
    diu_taken: '✅ Yes, I took it',
    diu_later: '⏰ Not yet, I will later today',
    diu_missed: '❌ I missed it / skipped it',
    noted: "Got it, I've noted that for your nurse. 📝",
    didnt_catch: "Sorry, I didn't quite catch that. You can tap the closest answer below 👇",
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
    photo_failed: "Sorry, I couldn't get that photo. Could you send it again?",
    // --- channel-level strings (used by channels/*) ---
    welcome_patient: "Hi {name}! 💙 I'm HeartBridge, your heart-health helper from the hospital. I'll check in with you every day. It only takes a minute. You can answer with the buttons, by typing, or with a voice note.",
    welcome_caregiver: "Hi! 💙 You're now connected as a caregiver for {name}. You'll get an alert here if something needs attention, plus a weekly summary.",
    unknown_code: 'Welcome to HeartBridge 💙 Please open the link your care team gave you (or send /start YOURCODE).',
    unknown_code_sms: 'Welcome to HeartBridge 💙 Please text JOIN followed by the code your care team gave you (for example: JOIN GARCIA1).',
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
    // --- refills (core/pharmacy.js) ---
    rx_nudge: "💊 Our records show your {med} prescription hasn't been picked up yet. It's important for your heart. Is something getting in the way?",
    rx_picked: '✅ I picked it up',
    rx_ride: '🚗 I need a ride',
    rx_cost: '💲 It costs too much',
    rx_other: '❓ Something else',
    rx_thanks: 'Wonderful, thank you! ✅ Take your {med} as prescribed.',
    rx_help_ride: "Thanks for telling me. 🚗 Most pharmacies can deliver or mail your {med}, often for free. Call the number on your prescription label and ask for delivery. I've also let your care team know so they can help.",
    rx_help_cost: "Thanks for telling me. 💲 There are ways to lower the price of {med}: ask your pharmacist for a generic or a discount program, and Medicare 'Extra Help' may cover it. I've asked your care team to help you with this.",
    rx_help_other: "Thanks for letting me know. A nurse from your care team will reach out to help you get your {med}.",
    // --- outreach ladder (core/outreach.js) ---
    outreach_reminder: 'Hi {name}, just checking on you 💙 When you have a minute, please answer today’s heart check-in. It helps your care team keep you well at home.',
    outreach_caregiver: "💙 HeartBridge: {name} hasn't answered today's heart check-in yet. Could you check on {name}? If you're with {name}, you can answer the questions here for them.",
    outreach_proxy_btn: '📋 Answer for {name}',
    // --- nurse workflow ---
    nurse_says: '👩‍⚕️ {nurse} (your care team): {text}',
    nurse_call_scheduled: '👩‍⚕️ {nurse} from your care team will call you at {time}. Please keep your phone nearby. 💙',
    nurse_ack: '💙 {nurse} from your care team saw your update and will contact you soon. If you feel worse before then, call 911.',
    // --- caregiver proxy check-in + weekly digest ---
    proxy_greeting: "Thank you for checking in for {name} 💙 I'll ask today's questions. Please answer them for {name}, based on how {name} is doing right now.",
    proxy_thanks_green: 'Thank you! {name} looks stable today. 👍',
    proxy_thanks_yellow: "Thank you. Some answers need a closer look, so I've asked {name}'s nurse to call today. If {name} gets worse before then, call the care team.",
    proxy_red_911: '🚨 What you described can be an emergency. Please CALL 911 NOW for {name}. I have alerted the care team.',
    proxy_not_enabled: "Caregiver check-ins aren't turned on for {name}. Please ask the care team.",
    digest_title: '💙 Weekly HeartBridge update for {name}',
    digest_weight: '⚖️ Weight: {start} → {end} lb ({delta} lb)',
    digest_weight_none: '⚖️ No weights recorded this week',
    digest_checkins: '📋 Check-ins answered: {done} of {expected} days',
    digest_adherence: '💊 Medicines taken: {pct}% of confirmed doses',
    digest_adherence_none: '💊 No medicine confirmations this week',
    digest_alerts: '🩺 Care-team alerts: {count} ({red} urgent)',
    digest_alerts_none: '🩺 No care-team alerts this week 👍',
    digest_refills: '🏥 Still to pick up at the pharmacy: {meds}',
    digest_footer: 'Thank you for helping {name} stay well at home.',
    // --- discharge companion (core/companion.js) ---
    companion_source: '📄 From {source}: "{title}"',
    src_discharge: 'your discharge instructions',
    src_guide: 'the HeartBridge heart-failure guide',
    companion_nurse: "Good question! I don't have that in your instructions, so I've sent it to your nurse, who will get back to you. 💙",
    companion_dosing: "Only your care team can change how you take your medicines, so I've sent your question to your nurse. Until they reply, please keep taking them as prescribed. 💊",
    companion_other: 'I can help with questions about your heart, medicines, food and daily care. For anything else, please ask your family or care team. 💙',
    companion_symptom_intro: "Thanks for telling me. Let's do a quick check-in so your nurse has the details.",
    // --- teach-back lessons (core/lessons.js) ---
    lesson_intro: "📚 Today's 1-minute heart tip",
    lesson_right: "✅ That's right!",
    lesson_wrong: "Not quite, and that's okay. 💙",
    // --- social-needs screen (core/sdoh.js) ---
    sdoh_intro: "💙 A few quick questions so we can make sure you have what you need at home. Just tap an answer.",
    sdoh_q_ride: 'Do you have a ride to your follow-up visit on {date}?',
    sdoh_ride_yes: '✅ Yes, I have a ride',
    sdoh_ride_no: '🚗 No, I need help',
    sdoh_q_cost: 'In the last month, have you skipped or cut back on medicines because of cost?',
    sdoh_cost_yes: '💲 Yes',
    sdoh_cost_no: '✅ No',
    sdoh_q_food: 'Is it hard to get healthy, low-salt food?',
    sdoh_food_yes: "🥫 Yes, it's hard",
    sdoh_food_no: '✅ No',
    sdoh_q_help: 'Is there someone who can help you at home if you feel sick?',
    sdoh_help_yes: '✅ Yes',
    sdoh_help_no: "🏠 No, I'm on my own",
    sdoh_done_none: "Thank you! It's great that you have support at home. 💙",
    sdoh_done_needs: "Thank you for telling me. Here's some help, and I've let your care team know:",
    sdoh_res_ride: 'Rides: many Medicare and Medicaid plans cover free rides to appointments. Call the number on your insurance card, or dial 211.',
    sdoh_res_cost: "Medicine costs: ask your pharmacist about generics or discount programs; Medicare 'Extra Help' can lower costs. Never skip doses, and your nurse will help.",
    sdoh_res_food: 'Food: Meals on Wheels and local food banks can deliver healthy meals. Dial 211 to find one near you.',
    sdoh_res_help: "Support at home: we'll check in with you often, and your care team can connect you with a community health worker.",
  },
  es: {
    greeting: '¡Buenos días {name}! 💙 Es hora de su chequeo diario del corazón: unas preguntas rápidas, casi todas con un solo toque.',
    ask_weight: '¿Cuánto pesa esta mañana, en libras? (Pésese después de ir al baño, antes del desayuno.) Escriba solo el número, ej. 172',
    bad_weight: 'No entendí el peso. Por favor escriba solo el número en libras, ej. 172',
    weight_confirm_up: 'Eso es {diff} libras más que su último peso ({last} libras). ¿Es correcto {lb} libras?',
    weight_confirm_down: 'Eso es {diff} libras menos que su último peso ({last} libras). ¿Es correcto {lb} libras?',
    weight_confirm_yes: '✅ Sí, {lb} libras es correcto',
    weight_confirm_no: '✏️ Quiero escribirlo de nuevo',
    ask_breath: '¿Cómo está su respiración hoy?',
    breath_normal: '😊 Normal',
    breath_exertion: '😮‍💨 Peor al caminar',
    breath_rest: '🚨 Difícil aun en reposo',
    ask_orthopnea: '¿Cómo durmió anoche?',
    orth_pillows: '🛏️ Necesité más almohadas / dormí sentado(a)',
    orth_pnd: '😮‍💨 Me desperté sin aire',
    orth_none: '😴 Dormí como siempre',
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
    ask_diuretic: '¿Ya tomó hoy su pastilla para el agua ({med})?',
    diu_taken: '✅ Sí, ya la tomé',
    diu_later: '⏰ Todavía no, la tomaré más tarde',
    diu_missed: '❌ Se me olvidó / no la tomé',
    noted: 'Entendido, lo anoté para su enfermera. 📝',
    didnt_catch: 'Perdón, no entendí bien. Puede tocar la respuesta más parecida abajo 👇',
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
    photo_failed: 'Perdón, no pude recibir esa foto. ¿Podría enviarla otra vez?',
    welcome_patient: '¡Hola {name}! 💙 Soy HeartBridge, su asistente de salud del corazón del hospital. La contactaré cada día; solo toma un minuto. Puede responder con los botones, escribiendo o con una nota de voz.',
    welcome_caregiver: '¡Hola! 💙 Ahora está conectado como cuidador de {name}. Recibirá una alerta aquí si algo necesita atención, y un resumen semanal.',
    unknown_code: 'Bienvenido a HeartBridge 💙 Por favor abra el enlace que le dio su equipo médico (o envíe /start SUCODIGO).',
    unknown_code_sms: 'Bienvenido a HeartBridge 💙 Por favor envíe JOIN seguido del código que le dio su equipo médico (por ejemplo: JOIN GARCIA1).',
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
    rx_nudge: '💊 Nuestros registros muestran que aún no ha recogido su receta de {med}. Es importante para su corazón. ¿Hay algo que se lo impide?',
    rx_picked: '✅ Ya la recogí',
    rx_ride: '🚗 Necesito transporte',
    rx_cost: '💲 Cuesta demasiado',
    rx_other: '❓ Otra cosa',
    rx_thanks: '¡Excelente, gracias! ✅ Tome su {med} como se lo recetaron.',
    rx_help_ride: 'Gracias por decírmelo. 🚗 La mayoría de las farmacias pueden entregar o enviar su {med} por correo, muchas veces gratis. Llame al número de la etiqueta de su receta y pida entrega a domicilio. También avisé a su equipo médico para que le ayuden.',
    rx_help_cost: "Gracias por decírmelo. 💲 Hay maneras de bajar el precio de {med}: pida a su farmacéutico un genérico o un programa de descuento, y la 'Ayuda Adicional' de Medicare puede cubrirlo. Le pedí a su equipo médico que le ayude con esto.",
    rx_help_other: 'Gracias por avisarme. Una enfermera de su equipo médico se comunicará para ayudarle a conseguir su {med}.',
    outreach_reminder: 'Hola {name}, solo quería saber de usted 💙 Cuando tenga un minuto, por favor conteste el chequeo del corazón de hoy. Ayuda a su equipo médico a cuidarle en casa.',
    outreach_caregiver: '💙 HeartBridge: {name} todavía no ha contestado el chequeo del corazón de hoy. ¿Podría ver cómo está {name}? Si está con {name}, puede contestar las preguntas aquí por él o ella.',
    outreach_proxy_btn: '📋 Contestar por {name}',
    nurse_says: '👩‍⚕️ {nurse} (su equipo médico): {text}',
    nurse_call_scheduled: '👩‍⚕️ {nurse} de su equipo médico le llamará a las {time}. Por favor tenga su teléfono cerca. 💙',
    nurse_ack: '💙 {nurse} de su equipo médico vio su mensaje y se comunicará pronto. Si se siente peor antes, llame al 911.',
    proxy_greeting: 'Gracias por hacer el chequeo de {name} 💙 Le haré las preguntas de hoy. Por favor contéstelas por {name}, según cómo está {name} ahora mismo.',
    proxy_thanks_green: '¡Gracias! {name} se ve estable hoy. 👍',
    proxy_thanks_yellow: 'Gracias. Algunas respuestas necesitan revisión, así que le pedí a la enfermera de {name} que llame hoy. Si {name} empeora antes, llame al equipo médico.',
    proxy_red_911: '🚨 Lo que describe puede ser una emergencia. Por favor LLAME AL 911 AHORA para {name}. Avisé al equipo médico.',
    proxy_not_enabled: 'Los chequeos por cuidador no están activados para {name}. Por favor consulte al equipo médico.',
    digest_title: '💙 Resumen semanal de HeartBridge para {name}',
    digest_weight: '⚖️ Peso: {start} → {end} lb ({delta} lb)',
    digest_weight_none: '⚖️ No se registró peso esta semana',
    digest_checkins: '📋 Chequeos contestados: {done} de {expected} días',
    digest_adherence: '💊 Medicinas tomadas: {pct}% de las dosis confirmadas',
    digest_adherence_none: '💊 No hubo confirmaciones de medicinas esta semana',
    digest_alerts: '🩺 Alertas al equipo médico: {count} ({red} urgentes)',
    digest_alerts_none: '🩺 Sin alertas al equipo médico esta semana 👍',
    digest_refills: '🏥 Falta recoger en la farmacia: {meds}',
    digest_footer: 'Gracias por ayudar a {name} a estar bien en casa.',
    companion_source: '📄 De {source}: "{title}"',
    src_discharge: 'sus instrucciones de alta',
    src_guide: 'la guía de insuficiencia cardíaca de HeartBridge',
    companion_nurse: '¡Buena pregunta! Eso no está en sus instrucciones, así que se la envié a su enfermera, quien le responderá. 💙',
    companion_dosing: 'Solo su equipo médico puede cambiar cómo toma sus medicinas, así que envié su pregunta a su enfermera. Mientras le responden, siga tomándolas como se las recetaron. 💊',
    companion_other: 'Puedo ayudarle con preguntas sobre su corazón, medicinas, comida y cuidado diario. Para otras cosas, pregunte a su familia o a su equipo médico. 💙',
    companion_symptom_intro: 'Gracias por decírmelo. Hagamos un chequeo rápido para que su enfermera tenga los detalles.',
    lesson_intro: '📚 Consejo del corazón de hoy (1 minuto)',
    lesson_right: '✅ ¡Correcto!',
    lesson_wrong: 'No exactamente, y está bien. 💙',
    sdoh_intro: '💙 Unas preguntas rápidas para asegurarnos de que tenga lo que necesita en casa. Solo toque una respuesta.',
    sdoh_q_ride: '¿Tiene transporte para su cita de seguimiento el {date}?',
    sdoh_ride_yes: '✅ Sí, tengo transporte',
    sdoh_ride_no: '🚗 No, necesito ayuda',
    sdoh_q_cost: 'En el último mes, ¿ha dejado o reducido sus medicinas por el costo?',
    sdoh_cost_yes: '💲 Sí',
    sdoh_cost_no: '✅ No',
    sdoh_q_food: '¿Le cuesta conseguir comida saludable y baja en sal?',
    sdoh_food_yes: '🥫 Sí, me cuesta',
    sdoh_food_no: '✅ No',
    sdoh_q_help: '¿Hay alguien que pueda ayudarle en casa si se siente mal?',
    sdoh_help_yes: '✅ Sí',
    sdoh_help_no: '🏠 No, estoy solo/a',
    sdoh_done_none: '¡Gracias! Qué bueno que tiene apoyo en casa. 💙',
    sdoh_done_needs: 'Gracias por decírmelo. Aquí tiene algo de ayuda, y ya le avisé a su equipo médico:',
    sdoh_res_ride: 'Transporte: muchos planes de Medicare y Medicaid cubren transporte gratis a las citas. Llame al número de su tarjeta de seguro, o marque 211.',
    sdoh_res_cost: "Costo de medicinas: pregunte a su farmacéutico por genéricos o programas de descuento; la 'Ayuda Adicional' de Medicare puede bajar el costo. Nunca deje sus dosis; su enfermera le ayudará.",
    sdoh_res_food: 'Comida: Meals on Wheels y los bancos de comida locales pueden llevarle comidas saludables. Marque 211 para encontrar uno cerca.',
    sdoh_res_help: 'Apoyo en casa: le contactaremos seguido, y su equipo médico puede conectarle con un trabajador de salud comunitario.',
  },
};

const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

// ---------- generated template translations (P2-11) ----------
// `npm run i18n:build` translates every English template once through the LLM chain
// into src/core/i18n-generated/<lang>.json ({ meta: { needsReview, model, ... }, strings }).
// localize() uses them first, so those languages work offline, instantly and
// consistently; anything not covered still goes through the live LLM.
const GENERATED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'i18n-generated');
const generated = {};
try {
  for (const f of fs.readdirSync(GENERATED_DIR).filter((x) => x.endsWith('.json'))) {
    generated[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(GENERATED_DIR, f), 'utf8'));
  }
} catch {
  /* no generated translations yet */
}
export const generatedDir = () => GENERATED_DIR;
export const generatedInfo = (lang) => generated[lang]?.meta ?? null;
export const _setGenerated = (lang, data) => (data ? (generated[lang] = data) : delete generated[lang]); // test hook

// English text produced by t() -> the template + values it came from, so localize()
// can rebuild the same message from a translated template. Bounded memory.
const FILLED_MAX = 5000;
const filledIndex = new Map();
function remember(text, key, vars) {
  if (filledIndex.size >= FILLED_MAX) filledIndex.delete(filledIndex.keys().next().value);
  filledIndex.set(text, { key, vars });
}

export const templateKeys = () => Object.keys(STRINGS.en);
export const enTemplate = (key) => STRINGS.en[key];
export const placeholdersOf = (s) => (String(s).match(/\{\w+\}/g) ?? []).sort();

// Synchronous lookup: en/es natively, everything else gets English (translated later by localize()).
export function t(lang, key, vars = {}) {
  const table = STRINGS[lang] ?? STRINGS.en;
  const text = fill(table[key] ?? STRINGS.en[key] ?? key, vars);
  if (!(lang in STRINGS) || lang === 'en') remember(text, key, vars);
  return text;
}

export const hasNative = (lang) => lang in STRINGS;

// Rebuild English text from generated templates. Whole text first, then line by line
// (digests, advice lists, lessons join several templates). -> { text, complete }
// Red-flag buttons are where a mistranslation hurts most (an early Hindi build turned
// "Hard even resting" into "pain even at rest"). Until a bilingual reviewer lists a key in
// meta.reviewed, machine-translated labels for these show the English too.
export const SAFETY_LABELS = new Set(['breath_rest', 'rf_chest', 'rf_dizzy', 'rf_confused', 'rf_fainted', 'rf_none']);

function fromGenerated(lang, text) {
  const strings = generated[lang]?.strings;
  if (!strings) return null;
  const reviewed = new Set(generated[lang]?.meta?.reviewed ?? []);
  const one = (s) => {
    const hit = filledIndex.get(s);
    if (!hit || !strings[hit.key]) return null;
    const tr = fill(strings[hit.key], hit.vars);
    return SAFETY_LABELS.has(hit.key) && !reviewed.has(hit.key) ? `${tr} (${s.replace(/^\p{Extended_Pictographic}\S*\s*/u, '')})` : tr;
  };
  const whole = one(text);
  if (whole) return { text: whole, complete: true };
  let complete = true;
  const lines = text.split('\n').map((line) => {
    if (!line.trim()) return line;
    const bullet = line.startsWith('• ') ? '• ' : '';
    const tr = one(line.slice(bullet.length));
    if (!tr) complete = false;
    return tr ? bullet + tr : line;
  });
  return { text: lines.join('\n'), complete };
}

const LANG_NAMES = { vi: 'Vietnamese', hi: 'Hindi', zh: 'Simplified Chinese', ko: 'Korean', fr: 'French', ar: 'Arabic', ht: 'Haitian Creole', pt: 'Portuguese', ru: 'Russian', tl: 'Tagalog' };
export const languageName = (lang) => LANG_NAMES[lang] ?? (lang === 'es' ? 'Spanish' : lang);
const cache = new Map();

// Translate an English string into the patient's language: generated templates first
// (offline), then the LLM chain (cached). Returns the original text if the language
// is native or nothing can translate it.
export async function localize(lang, text) {
  if (hasNative(lang) || !text) return text;
  const gen = fromGenerated(lang, text);
  if (gen?.complete) return gen.text;
  if (!llm.enabled()) return gen?.text ?? text; // offline: best effort (translated lines + English rest)
  const key = `${lang}:${text}`;
  if (cache.has(key)) return cache.get(key);
  const out = await llm.complete(
    `Translate the user's message into ${LANG_NAMES[lang] ?? lang} for an elderly heart-failure patient. ` +
      'Keep it simple and warm, and use the respectful/formal form of address (e.g. "usted" in Spanish, "Bác/ông/bà" in Vietnamese, "आप" in Hindi). ' +
      'Keep emojis, numbers and "911" unchanged. Output only the translation.',
    text,
  );
  const result = out || text;
  cache.set(key, result);
  return result;
}

// Translate free text written in English (e.g. a nurse's message) into ANY patient
// language, including es (templates can't cover free text). Returns
// { text, translated } and falls back to the English original without an LLM.
export async function translateFromEnglish(lang, text) {
  if (lang === 'en' || !text) return { text, translated: false };
  const key = `free:${lang}:${text}`;
  if (cache.has(key)) return { text: cache.get(key), translated: true };
  const out = await llm.complete(
    `Translate the message from a nurse into ${LANG_NAMES[lang] ?? (lang === 'es' ? 'Spanish' : lang)} for an elderly heart-failure patient. ` +
      'Use the respectful/formal form of address (e.g. "usted" in Spanish, "Bác/ông/bà" in Vietnamese, "आप" in Hindi). ' +
      'Keep names, times, numbers, emojis and "911" unchanged. Output only the translation.',
    text,
  );
  if (!out) return { text, translated: false };
  cache.set(key, out);
  return { text: out, translated: true };
}

// Translate patient text into English for the care-team dashboard.
export async function toEnglish(lang, text) {
  if (lang === 'en' || !text) return null;
  const out = await llm.complete('Translate into English. Output only the translation.', text, 200);
  return out;
}
