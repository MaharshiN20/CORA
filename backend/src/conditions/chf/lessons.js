// Teach-back micro-lessons for heart failure (P2-9). One per day, each ends with a
// question so we learn whether the patient actually understood (teach-back), not
// just whether they received a message. Bilingual (en/es); other languages are
// translated by the LLM chain. Order = the order they're sent.
// option.correct marks the right answer; `explain` is shown after any answer.

export const LESSONS = [
  {
    id: 'weigh',
    en: {
      tip: 'Weighing yourself every morning is the best early warning for fluid build-up. It often shows up days before you feel short of breath.',
      question: 'If you gain 3 lb since yesterday, what should you do?',
      options: [{ label: '📞 Call my care team today', correct: true }, { label: '⏳ Wait a week and see' }, { label: '💧 Drink more water' }],
      explain: 'A gain of 2 lb in a day (or 5 lb in a week) means call your care team the same day.',
    },
    es: {
      tip: 'Pesarse cada mañana es la mejor señal temprana de acumulación de líquido. Muchas veces aparece días antes de sentir falta de aire.',
      question: 'Si sube 3 libras desde ayer, ¿qué debe hacer?',
      options: [{ label: '📞 Llamar hoy a mi equipo médico', correct: true }, { label: '⏳ Esperar una semana' }, { label: '💧 Tomar más agua' }],
      explain: 'Subir 2 libras en un día (o 5 en una semana) significa llamar a su equipo médico el mismo día.',
    },
  },
  {
    id: 'salt',
    en: {
      tip: 'Salt makes your body hold on to water, which makes your heart work harder. Most salt is hidden in packaged and restaurant food.',
      question: 'Which of these has the most salt?',
      options: [{ label: '🥫 A can of soup', correct: true }, { label: '🍎 A fresh apple' }, { label: '🍚 Plain rice' }],
      explain: 'One can of soup can have 800+ mg of sodium, almost half a day\'s limit.',
    },
    es: {
      tip: 'La sal hace que el cuerpo retenga agua y el corazón trabaje más. La mayoría de la sal está escondida en comida empacada y de restaurante.',
      question: '¿Cuál de estos tiene más sal?',
      options: [{ label: '🥫 Una lata de sopa', correct: true }, { label: '🍎 Una manzana' }, { label: '🍚 Arroz blanco' }],
      explain: 'Una lata de sopa puede tener más de 800 mg de sodio, casi la mitad del límite del día.',
    },
  },
  {
    id: 'fluid',
    en: {
      tip: 'Your fluid limit counts everything that is liquid at room temperature.',
      question: 'Does soup count toward your fluid limit?',
      options: [{ label: '✅ Yes', correct: true }, { label: '❌ No, only water counts' }],
      explain: 'Soup, coffee, juice, ice and popsicles all count toward your daily fluid limit.',
    },
    es: {
      tip: 'Su límite de líquidos cuenta todo lo que es líquido a temperatura ambiente.',
      question: '¿La sopa cuenta en su límite de líquidos?',
      options: [{ label: '✅ Sí', correct: true }, { label: '❌ No, solo el agua cuenta' }],
      explain: 'La sopa, el café, el jugo, el hielo y las paletas cuentan en su límite diario de líquidos.',
    },
  },
  {
    id: 'water_pill',
    en: {
      tip: 'Your water pill helps your body get rid of extra fluid. It makes you pee more for a few hours.',
      question: 'When is the best time to take your water pill?',
      options: [{ label: '🌅 In the morning', correct: true }, { label: '🌙 At bedtime' }, { label: '🤷 Only when I feel swollen' }],
      explain: 'Morning is best so you are not up at night. Take it every day, even when you feel fine.',
    },
    es: {
      tip: 'Su pastilla para el agua ayuda al cuerpo a eliminar el líquido extra. Le hace orinar más por unas horas.',
      question: '¿Cuál es el mejor momento para tomar su pastilla para el agua?',
      options: [{ label: '🌅 En la mañana', correct: true }, { label: '🌙 Al acostarme' }, { label: '🤷 Solo cuando me siento hinchado' }],
      explain: 'En la mañana es mejor para no levantarse de noche. Tómela todos los días, aunque se sienta bien.',
    },
  },
  {
    id: 'pillows',
    en: {
      tip: 'How you sleep can tell you a lot about your heart.',
      question: 'Needing more pillows to breathe at night can mean…',
      options: [{ label: '💧 Fluid is building up', correct: true }, { label: '🛏️ Nothing, it is normal' }],
      explain: 'Needing more pillows or waking up short of breath is a warning sign. Tell your care team.',
    },
    es: {
      tip: 'Cómo duerme puede decir mucho de su corazón.',
      question: 'Necesitar más almohadas para respirar de noche puede significar…',
      options: [{ label: '💧 Se está acumulando líquido', correct: true }, { label: '🛏️ Nada, es normal' }],
      explain: 'Necesitar más almohadas o despertarse sin aire es una señal de alerta. Avise a su equipo médico.',
    },
  },
  {
    id: 'painkillers',
    en: {
      tip: 'Some common pain pills make heart failure worse.',
      question: 'Which pain pill can be risky with heart failure?',
      options: [{ label: '💊 Ibuprofen (Advil, Motrin)', correct: true }, { label: '💊 Acetaminophen (Tylenol)' }],
      explain: 'Ibuprofen and naproxen make your body hold salt and water. Ask your care team before any pain pill.',
    },
    es: {
      tip: 'Algunas pastillas comunes para el dolor empeoran la insuficiencia cardíaca.',
      question: '¿Qué pastilla para el dolor puede ser riesgosa con insuficiencia cardíaca?',
      options: [{ label: '💊 Ibuprofeno (Advil, Motrin)', correct: true }, { label: '💊 Acetaminofén (Tylenol)' }],
      explain: 'El ibuprofeno y el naproxeno hacen que el cuerpo retenga sal y agua. Pregunte a su equipo antes de tomar cualquier analgésico.',
    },
  },
  {
    id: 'activity',
    en: {
      tip: 'Staying gently active helps your heart get stronger.',
      question: 'You feel short of breath while walking. What should you do?',
      options: [{ label: '🪑 Stop, rest and slow down', correct: true }, { label: '🏃 Push through it' }],
      explain: 'Rest until your breathing is back to normal. If it happens at rest, call 911.',
    },
    es: {
      tip: 'Mantenerse activo con calma ayuda a que su corazón se fortalezca.',
      question: 'Le falta el aire mientras camina. ¿Qué debe hacer?',
      options: [{ label: '🪑 Parar, descansar e ir más despacio', correct: true }, { label: '🏃 Seguir de todos modos' }],
      explain: 'Descanse hasta que su respiración vuelva a la normalidad. Si le pasa en reposo, llame al 911.',
    },
  },
  {
    id: 'call_911',
    en: {
      tip: 'Knowing when it is an emergency can save your life.',
      question: 'Chest pain that does not go away. What do you do?',
      options: [{ label: '🚑 Call 911 right away', correct: true }, { label: '⏰ Wait until morning' }, { label: '💬 Text my nurse' }],
      explain: 'Chest pain, trouble breathing at rest, fainting or sudden confusion: always call 911.',
    },
    es: {
      tip: 'Saber cuándo es una emergencia puede salvarle la vida.',
      question: 'Dolor de pecho que no se quita. ¿Qué hace?',
      options: [{ label: '🚑 Llamar al 911 de inmediato', correct: true }, { label: '⏰ Esperar hasta la mañana' }, { label: '💬 Mandar mensaje a mi enfermera' }],
      explain: 'Dolor de pecho, dificultad para respirar en reposo, desmayo o confusión repentina: siempre llame al 911.',
    },
  },
];
