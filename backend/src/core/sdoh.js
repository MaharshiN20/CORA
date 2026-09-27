// Social-needs screen (P2-10). Readmissions are driven as much by rides, money,
// food and loneliness as by the heart itself. On day 2 after discharge the patient
// gets four one-tap questions (one at a time). Each need found gets a concrete
// resource right away, a flag on the patient (signals.sdohFlags -> dynamic risk),
// and one summary task for the care team.
//
//   patient.sdoh = { flags: string[], answers: { ride, cost, food, help }, pending: [q], screenedAt }
//   Button data: sdoh:<question>:<answer>
import * as store from '../store.js';
import * as clock from './clock.js';
import * as scheduler from './scheduler.js';
import * as channels from '../channels/index.js';
import { t, hasNative, localize } from './i18n.js';
import { addPlanner, occurrences, isMonitored } from './planning.js';
import { skipDuringRedLock } from './escalation.js';

const SCREEN_TIME = '12:00';
export const QUESTIONS = ['ride', 'cost', 'food', 'help'];
// Which answer means a need, and the flag it sets (flags are shared with pharmacy.js).
const NEED = {
  ride: { answer: 'no', flag: 'transportation' },
  cost: { answer: 'yes', flag: 'medication_cost' },
  food: { answer: 'yes', flag: 'food_insecurity' },
  help: { answer: 'no', flag: 'social_isolation' },
};
const RESOURCE_KEY = { transportation: 'sdoh_res_ride', medication_cost: 'sdoh_res_cost', food_insecurity: 'sdoh_res_food', social_isolation: 'sdoh_res_help' };
const NEED_LABEL = { transportation: 'No ride to follow-up', medication_cost: 'Skipping medicines due to cost', food_insecurity: 'Hard to get healthy food', social_isolation: 'No one to help at home' };

const fmtDate = (iso, lang) => new Date(iso).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric' });

async function say(p, key, vars) {
  const L = hasNative(p.language) ? p.language : 'en';
  const text = t(L, key, vars);
  return { text: hasNative(p.language) ? text : await localize(p.language, text), textEn: t('en', key, vars) };
}

async function questionReply(p, q) {
  const L = hasNative(p.language) ? p.language : 'en';
  const date = p.followUp?.at ? fmtDate(p.followUp.at, L) : '';
  const msg = await say(p, `sdoh_q_${q}`, { date });
  const opts = ['yes', 'no'];
  const labels = await Promise.all(opts.map(async (a) => (hasNative(p.language) ? t(L, `sdoh_${q}_${a}`) : localize(p.language, t('en', `sdoh_${q}_${a}`)))));
  return { ...msg, buttons: [opts.map((a, i) => ({ label: labels[i], data: `sdoh:${q}:${a}` }))] };
}

// Start (or restart) the screen: intro + first question.
export async function startScreen(patientId) {
  const p = store.getPatient(patientId);
  if (!p) throw Object.assign(new Error('patient not found'), { status: 404 });
  store.updatePatient(p.id, { sdoh: { flags: p.sdoh?.flags ?? [], answers: {}, pending: [...QUESTIONS], startedAt: clock.nowISO() } });
  const replies = [await say(p, 'sdoh_intro'), await questionReply(store.getPatient(p.id), QUESTIONS[0])];
  store.audit('sdoh', p.id, { event: 'started' });
  return replies;
}

scheduler.defineJob('sdoh_screen', {
  skipIf: skipDuringRedLock,
  async run(job) {
    const p = store.getPatient(job.patientId);
    if (p.sdoh?.screenedAt) return { skipped: 'already screened' };
    const replies = await startScreen(p.id);
    for (const r of replies) await channels.sendToPatient(store.getPatient(p.id), r);
    return { started: true };
  },
});

// Once per patient: the first noon at least a day after discharge (single key = never twice).
addPlanner((p, fromMs, toMs) => {
  if (p.sdoh?.screenedAt || p.sdoh?.pending?.length) return;
  const earliest = Date.parse(p.dischargedAt) + clock.DAY;
  const slot = occurrences([SCREEN_TIME], Math.max(fromMs, earliest - 1), toMs).find(({ at }) => isMonitored(p, at));
  if (slot) scheduler.schedule({ kind: 'sdoh_screen', patientId: p.id, dueAt: slot.at, key: `sdoh_screen:${p.id}` });
});

// Handle a sdoh:* tap. Returns Reply[] (next question, or the summary with resources).
export async function handleButton(patient, data) {
  const [, q, answer] = data.split(':');
  const s = patient.sdoh ?? {};
  if (!QUESTIONS.includes(q) || !['yes', 'no'].includes(answer) || !s.pending?.includes(q)) return [await say(patient, 'med_already')];

  const answers = { ...s.answers, [q]: answer };
  const pending = s.pending.filter((x) => x !== q);
  const flags = new Set(s.flags ?? []);
  if (NEED[q].answer === answer) flags.add(NEED[q].flag);
  store.updatePatient(patient.id, { sdoh: { ...s, answers, pending, flags: [...flags] } });
  store.audit('sdoh', patient.id, { event: 'answer', question: q, answer });

  if (pending.length) return [await questionReply(store.getPatient(patient.id), pending[0])];

  // Screen complete: resources for every need found + one task for the care team.
  const needs = QUESTIONS.filter((x) => NEED[x].answer === answers[x]).map((x) => NEED[x].flag);
  store.updatePatient(patient.id, { sdoh: { ...store.getPatient(patient.id).sdoh, screenedAt: clock.nowISO() } });
  store.audit('sdoh', patient.id, { event: 'completed', needs });
  if (!needs.length) return [await say(patient, 'sdoh_done_none')];

  store.addTask({
    patientId: patient.id,
    kind: 'sdoh',
    tier: 'INFO',
    title: `Social needs: ${needs.map((n) => NEED_LABEL[n]).join(', ')}`,
    reasons: needs.map((n) => NEED_LABEL[n]),
    needs,
  });
  const lines = await Promise.all(needs.map((n) => say(patient, RESOURCE_KEY[n])));
  const head = await say(patient, 'sdoh_done_needs');
  return [{ text: [head.text, ...lines.map((l) => `• ${l.text}`)].join('\n'), textEn: [head.textEn, ...lines.map((l) => `• ${l.textEn}`)].join('\n') }];
}
