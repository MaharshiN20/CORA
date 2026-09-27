// Discharge companion (P2-8): answers everyday questions ("¿Puedo comer sopa de lata?")
// ONLY from the patient's own discharge instructions and the heart-failure guide,
// always citing the source. Order of safety checks (agent.js runs the emergency
// check before this):
//   1. medication-change questions ("can I skip my water pill?") -> always the nurse
//      (deterministic regex, before any LLM sees it)
//   2. LLM (if available): answer strictly from numbered sources, validated; says
//      when it's not covered, flags symptoms and dosing
//   3. no LLM: keyword match over bilingual sections
//   4. not covered -> "I'll ask your nurse" + nurse task (never a guess)
import * as store from '../store.js';
import * as llm from './llm/index.js';
import { t, hasNative, toEnglish } from './i18n.js';
import { allSections } from '../conditions/chf/content.js';

const LANG_NAMES = { en: 'English', es: 'Spanish', vi: 'Vietnamese', zh: 'Simplified Chinese', hi: 'Hindi', ko: 'Korean', ht: 'Haitian Creole', ar: 'Arabic', pt: 'Portuguese', tl: 'Tagalog' };

// Asking to change how a medicine is taken: only a clinician answers that.
export const DOSING_CHANGE =
  /\b(skip|stop|quit|double|extra|more|less|half|cut|change|increase|decrease|lower|raise)\b.{0,30}\b(pill|pills|dose|doses|medicine|medicines|medication|meds|furosemide|lasix|carvedilol|coreg|lisinopril|water pill)|\b(dejar|dejo|saltar|salto|suspender|doble|duplicar|más|menos|mitad|cambiar|aumentar|bajar)\b.{0,30}\b(pastilla|pastillas|dosis|medicina|medicinas|medicamento|furosemida|carvedilol|lisinopril)/i;

const QUESTION_START =
  /^(can|could|should|may|is|are|do|does|did|what|when|where|why|how|which|who|will|am|puedo|puede|debo|debería|es|está|qué|que|cuándo|cuando|dónde|por qué|cómo|como|cuál|cuánto|cuanto)\b/i;

export function looksLikeQuestion(text) {
  const s = String(text ?? '').trim();
  return s.includes('?') || s.includes('¿') || QUESTION_START.test(s);
}

const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const sectionIn = (sec, lang) => sec[lang] ?? sec.en;
const both = (lang, key, vars) => ({ text: t(lang, key, vars), textEn: t('en', key, vars) });

// Offline retrieval: weighted keyword hits (longer, more specific keywords count double).
// Keywords match at word starts, so stems work ("enlatad") but "eat" doesn't fire inside "great".
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const kwRegex = new Map();
const hits = (q, kw) => {
  if (!kwRegex.has(kw)) kwRegex.set(kw, new RegExp(`(^|[^a-z0-9])${escapeRe(norm(kw))}`));
  return kwRegex.get(kw).test(q);
};

export function matchSection(patient, question) {
  const q = norm(question);
  let best = null;
  for (const sec of allSections(patient)) {
    let score = 0;
    for (const kw of sec.keywords) if (hits(q, kw)) score += kw.length >= 5 ? 2 : 1;
    if (!score) continue;
    const rank = score + (sec.source === 'discharge' ? 0.5 : 0);
    if (!best || rank > best.rank) best = { sec, rank };
  }
  return best?.sec ?? null;
}

function citation(lang, sec) {
  const s = sectionIn(sec, lang);
  const source = t(lang, sec.source === 'discharge' ? 'src_discharge' : 'src_guide');
  return t(lang, 'companion_source', { source, title: s.title });
}

async function nurseTask(patient, question, { dosing = false } = {}) {
  const lang = patient.language;
  const textEn = lang === 'en' ? question : (await toEnglish(lang, question)) ?? question;
  store.addTask({
    patientId: patient.id,
    kind: 'question',
    tier: dosing ? 'YELLOW' : 'INFO',
    title: `${dosing ? 'Medication question' : 'Question'}: ${textEn}`.slice(0, 120),
    reasons: [textEn, ...(textEn !== question ? [`Original: ${question}`] : []), ...(dosing ? ['Asks about changing how a medicine is taken'] : [])],
    question,
    dosing,
  });
}

// -> { kind: 'answer'|'nurse'|'dosing'|'symptom'|'other', replies, sectionIds? }
// kind 'symptom' means the caller should start a check-in instead.
export async function answer(patient, question) {
  const lang = patient.language;
  const L = hasNative(lang) ? lang : 'en'; // non-native languages get localized by agent.js

  if (DOSING_CHANGE.test(question)) {
    await nurseTask(patient, question, { dosing: true });
    store.audit('companion', patient.id, { kind: 'dosing' });
    return { kind: 'dosing', replies: [both(L, 'companion_dosing')] };
  }

  const sections = allSections(patient);

  if (llm.enabled()) {
    const sources = sections.map((s) => `[${s.id}] ${s.en.title}: ${s.en.text}`).join('\n');
    const out = await llm.completeJSON(
      'You are HeartBridge, a discharge companion for a heart-failure patient. Answer the patient\'s message ONLY using the numbered sources below. ' +
        'Never invent medical advice, never change medicine doses, never diagnose. ' +
        `Write the answer in ${LANG_NAMES[lang] ?? 'English'}, warm and simple, at most 3 short sentences.\n` +
        'Return JSON: {"category": "question"|"symptom"|"dosing"|"other", "covered": boolean, "answer": string, "sourceIds": string[]}. ' +
        '"symptom" = the patient describes how they feel (swelling, breathing, weight, dizziness). "dosing" = asks to change/skip/add a medicine. ' +
        '"other" = not about their health. "covered" = false if the sources do not answer it.\n\nSOURCES:\n' + sources,
      question,
    );
    if (out) {
      if (out.category === 'dosing') {
        await nurseTask(patient, question, { dosing: true });
        store.audit('companion', patient.id, { kind: 'dosing', via: 'llm' });
        return { kind: 'dosing', replies: [both(L, 'companion_dosing')] };
      }
      if (out.category === 'symptom') return { kind: 'symptom', replies: [] };
      if (out.category === 'other') return { kind: 'other', replies: [both(L, 'companion_other')] };
      const ids = (out.sourceIds ?? []).filter((id) => sections.some((s) => s.id === id));
      if (out.covered && out.answer?.trim() && ids.length) {
        const sec = sections.find((s) => s.id === ids[0]);
        store.audit('companion', patient.id, { kind: 'answer', via: 'llm', sectionIds: ids });
        // The LLM already wrote in the patient's language: send as-is, cite in their language when native.
        const text = `${out.answer.trim()}\n\n${citation(L, sec)}`;
        return { kind: 'answer', sectionIds: ids, replies: [{ text, textEn: `${sec.en.text}\n\n${citation('en', sec)}`, localized: true }] };
      }
      // fall through: not covered -> nurse
    }
  }

  if (!llm.enabled()) {
    const sec = matchSection(patient, question);
    if (sec) {
      store.audit('companion', patient.id, { kind: 'answer', via: 'keywords', sectionIds: [sec.id] });
      const s = sectionIn(sec, L);
      return {
        kind: 'answer',
        sectionIds: [sec.id],
        replies: [{ text: `${s.text}\n\n${citation(L, sec)}`, textEn: `${sec.en.text}\n\n${citation('en', sec)}` }],
      };
    }
  }

  await nurseTask(patient, question);
  store.audit('companion', patient.id, { kind: 'nurse' });
  return { kind: 'nurse', replies: [both(L, 'companion_nurse')] };
}
