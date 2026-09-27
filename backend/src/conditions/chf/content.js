// Heart-failure knowledge the discharge companion (core/companion.js) may answer from.
// Two sources, both bilingual (en/es) so the no-LLM fallback works offline:
//   1. dischargeSections(patient): personalised from the patient's record (dry
//      weight, their meds, fluid limit, follow-up), i.e. "your discharge instructions"
//   2. GUIDE: general patient education (AHA/HFSA self-care themes)
// Each section: { id, source: 'discharge'|'guide', title, text, keywords } per language.
// Keywords are lowercase words or stems ("enlatad" matches enlatada/enlatado), matched at word
// starts against the question for the offline fallback. Avoid generic verbs (take, tomar, can).
// Content is education only; no dosing decisions (those always go to the nurse).

const fmtDate = (iso, lang) =>
  new Date(iso).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric' });

export function dischargeSections(p) {
  const dry = p.dryWeightLb;
  const fluid = p.carePlan?.fluidLimitL ?? 2;
  const cups = Math.round(fluid * 4.2);
  const sodium = p.carePlan?.sodiumMg ?? 2000;
  const meds = (p.meds ?? []).map((m) => `${m.name} ${m.dose ?? ''} (${(m.times ?? []).join(', ')})`.replace(/\s+/g, ' '));
  const fu = p.followUp;

  return [
    {
      id: 'd_weight',
      source: 'discharge',
      keywords: ['weigh', 'weight', 'scale', 'pound', 'gain', 'peso', 'pesar', 'báscula', 'libra', 'subir'],
      en: {
        title: 'Daily weight',
        text: `Weigh yourself every morning after using the bathroom, before breakfast.${dry ? ` Your target ("dry") weight is ${dry} lb.` : ''} Call your care team if you gain 2 lb or more in a day, or 5 lb or more in a week.`,
      },
      es: {
        title: 'Peso diario',
        text: `Pésese cada mañana después de ir al baño y antes del desayuno.${dry ? ` Su peso meta ("seco") es ${dry} libras.` : ''} Llame a su equipo médico si sube 2 libras o más en un día, o 5 libras o más en una semana.`,
      },
    },
    {
      id: 'd_meds',
      source: 'discharge',
      keywords: ['medicine', 'medication', 'pill', 'dose', 'furosemide', 'lasix', 'carvedilol', 'lisinopril', 'medicina', 'pastilla', 'dosis', 'medicamento'],
      en: {
        title: 'Your medicines',
        text: `Take your medicines every day as prescribed: ${meds.join('; ')}. Do not stop or change any medicine without talking to your care team.`,
      },
      es: {
        title: 'Sus medicinas',
        text: `Tome sus medicinas todos los días como se las recetaron: ${meds.join('; ')}. No deje ni cambie ninguna medicina sin hablar con su equipo médico.`,
      },
    },
    {
      id: 'd_diet',
      source: 'discharge',
      keywords: ['salt', 'sodium', 'eat', 'food', 'soup', 'canned', 'chip', 'pizza', 'restaurant', 'fast food', 'diet', 'sal', 'sodio', 'comer', 'comida', 'sopa', 'lata', 'enlatad', 'papitas', 'restaurante', 'dieta'],
      en: {
        title: 'Low-salt eating',
        text: `Keep salt (sodium) under ${sodium.toLocaleString('en-US')} mg a day. Salt makes your body hold water. Avoid canned soups, deli meats, chips, frozen dinners and fast food, or choose "low sodium" versions. Read labels: under 140 mg per serving is low.`,
      },
      es: {
        title: 'Comer con poca sal',
        text: `Mantenga la sal (sodio) por debajo de ${sodium.toLocaleString('es-US')} mg al día. La sal hace que el cuerpo retenga agua. Evite sopas de lata, embutidos, papitas, comidas congeladas y comida rápida, o elija versiones "bajas en sodio". Lea las etiquetas: menos de 140 mg por porción es bajo.`,
      },
    },
    {
      id: 'd_fluid',
      source: 'discharge',
      keywords: ['drink', 'water', 'fluid', 'liquid', 'thirst', 'coffee', 'juice', 'ice', 'beber', 'agua', 'cuanta agua', 'líquido', 'liquido', 'sed', 'café', 'jugo', 'hielo'],
      en: {
        title: 'Fluid limit',
        text: `Drink no more than ${fluid} liters a day (about ${cups} cups). That includes water, coffee, juice, soup, ice and popsicles. Sucking on sugar-free hard candy or frozen grapes can help with thirst.`,
      },
      es: {
        title: 'Límite de líquidos',
        text: `No tome más de ${fluid} litros al día (unas ${cups} tazas). Eso incluye agua, café, jugo, sopa, hielo y paletas. Chupar dulces sin azúcar o uvas congeladas ayuda con la sed.`,
      },
    },
    {
      id: 'd_activity',
      source: 'discharge',
      keywords: ['walk', 'exercise', 'activity', 'lift', 'stairs', 'tired', 'drive', 'caminar', 'ejercicio', 'actividad', 'levantar', 'escaleras', 'cansad', 'manejar'],
      en: {
        title: 'Activity',
        text: 'Walk a little every day, starting with 5–10 minutes and adding a bit more each day. Rest when you feel short of breath. Do not lift anything heavier than 10 lb for the first 2 weeks.',
      },
      es: {
        title: 'Actividad',
        text: 'Camine un poco cada día, empezando con 5 a 10 minutos y agregando un poco más cada día. Descanse cuando le falte el aire. No levante nada de más de 10 libras las primeras 2 semanas.',
      },
    },
    {
      id: 'd_followup',
      source: 'discharge',
      keywords: ['appointment', 'doctor', 'visit', 'follow', 'clinic', 'when do i see', 'cita', 'doctor', 'médico', 'visita', 'clínica', 'consulta'],
      en: {
        title: 'Follow-up visit',
        text: fu
          ? `Your follow-up visit is with ${fu.with} on ${fmtDate(fu.at, 'en')}. Bring your medicines and your weight log.`
          : 'Your care team will call you to schedule a follow-up visit within 7 days.',
      },
      es: {
        title: 'Cita de seguimiento',
        text: fu
          ? `Su cita de seguimiento es con ${fu.with} el ${fmtDate(fu.at, 'es')}. Lleve sus medicinas y su registro de peso.`
          : 'Su equipo médico le llamará para programar una cita de seguimiento dentro de 7 días.',
      },
    },
    {
      id: 'd_warning',
      source: 'discharge',
      keywords: ['when to call', 'emergency', '911', 'warning', 'worse', 'call', 'emergencia', 'llamar', 'peor', 'señal'],
      en: {
        title: 'When to call',
        text: 'Call 911 for chest pain, trouble breathing at rest, fainting or new confusion. Call your care team the same day for weight gain (2 lb in a day or 5 lb in a week), more swelling, needing more pillows to sleep, or feeling dizzy.',
      },
      es: {
        title: 'Cuándo llamar',
        text: 'Llame al 911 si tiene dolor de pecho, dificultad para respirar en reposo, desmayo o confusión nueva. Llame a su equipo médico el mismo día si sube de peso (2 libras en un día o 5 en una semana), tiene más hinchazón, necesita más almohadas para dormir o se siente mareado.',
      },
    },
  ];
}

export const GUIDE = [
  {
    id: 'g_painkillers',
    source: 'guide',
    keywords: ['ibuprofen', 'advil', 'motrin', 'aleve', 'naproxen', 'pain', 'painkiller', 'headache', 'tylenol', 'acetaminophen', 'dolor', 'ibuprofeno', 'analgésico', 'cabeza'],
    en: {
      title: 'Pain relievers',
      text: 'Avoid ibuprofen (Advil, Motrin) and naproxen (Aleve): they make your body hold salt and water and can worsen heart failure. Acetaminophen (Tylenol) is usually safer, but ask your care team first.',
    },
    es: {
      title: 'Analgésicos',
      text: 'Evite el ibuprofeno (Advil, Motrin) y el naproxeno (Aleve): hacen que el cuerpo retenga sal y agua y pueden empeorar la insuficiencia cardíaca. El acetaminofén (Tylenol) suele ser más seguro, pero pregunte primero a su equipo médico.',
    },
  },
  {
    id: 'g_alcohol',
    source: 'guide',
    keywords: ['alcohol', 'beer', 'wine', 'drink alcohol', 'cerveza', 'vino', 'trago'],
    en: { title: 'Alcohol', text: 'Alcohol weakens the heart muscle. It is best to avoid it, or have no more than one drink a day if your doctor says it is OK.' },
    es: { title: 'Alcohol', text: 'El alcohol debilita el músculo del corazón. Es mejor evitarlo, o tomar no más de una bebida al día si su doctor dice que está bien.' },
  },
  {
    id: 'g_water_pill_timing',
    source: 'guide',
    keywords: ['bathroom', 'pee', 'urinate', 'night', 'outing', 'church', 'baño', 'orinar', 'noche', 'salir', 'misa'],
    en: {
      title: 'Planning around your water pill',
      text: 'Your water pill (furosemide) makes you pee more for about 6 hours. Taking it in the morning keeps you from getting up at night. If you have an outing, plan to be near a bathroom for a few hours after your dose. Do not skip it.',
    },
    es: {
      title: 'Planear con su pastilla para el agua',
      text: 'Su pastilla para el agua (furosemida) le hace orinar más por unas 6 horas. Tomarla en la mañana evita que se levante de noche. Si va a salir, planee estar cerca de un baño unas horas después de la dosis. No la deje de tomar.',
    },
  },
  {
    id: 'g_why_weight',
    source: 'guide',
    keywords: ['why weigh', 'why weight', 'fluid build', 'swelling', 'swollen', 'ankle', 'por qué pesar', 'hinchazón', 'hinchad', 'tobillo'],
    en: {
      title: 'Why daily weight matters',
      text: 'A quick weight gain usually means your body is holding extra fluid, often days before you feel short of breath. Catching it early lets your care team adjust your treatment at home instead of in the hospital.',
    },
    es: {
      title: 'Por qué importa el peso diario',
      text: 'Subir de peso rápido casi siempre significa que el cuerpo está reteniendo líquido, muchas veces días antes de sentir falta de aire. Detectarlo temprano permite que su equipo ajuste el tratamiento en casa y no en el hospital.',
    },
  },
];

export function allSections(patient) {
  return [...dischargeSections(patient), ...GUIDE];
}
