// Teach-back micro-lessons (P2-9): one short tip + question per day at 17:00.
// Right answer -> reinforcement. Wrong answer -> the explanation, and the lesson
// comes back once more later (teach-back = re-explain what was missed).
// patient.lessons = { sent: [id], queue: [id], answers: { [id]: { attempts, correct, firstCorrect } }, score }
// score = share of lessons answered right on the first try (feeds signals.lessonScore).
//
// Button data: lesson:<id>:<optionIndex>
import * as store from '../store.js';
import * as clock from './clock.js';
import * as scheduler from './scheduler.js';
import * as channels from '../channels/index.js';
import { t, hasNative, localize } from './i18n.js';
import { addPlanner, occurrences, isMonitored, tzOf } from './planning.js';
import { LESSONS } from '../conditions/chf/lessons.js';
import { skipDuringRedLock } from './escalation.js';

const LESSON_TIME = '17:00';
const MAX_ATTEMPTS = 2;

const state = (p) => ({ sent: [], queue: [], answers: {}, score: null, ...(p.lessons ?? {}) });
const content = (lesson, lang) => lesson[lang] ?? lesson.en;
const byId = (id) => LESSONS.find((l) => l.id === id);

// Next lesson to send: retries first (teach-back), then the first never-sent lesson.
export function nextLesson(p) {
  const s = state(p);
  const retry = s.queue.find((id) => (s.answers[id]?.attempts ?? 0) < MAX_ATTEMPTS && !s.answers[id]?.correct);
  if (retry) return byId(retry);
  return LESSONS.find((l) => !s.sent.includes(l.id)) ?? null;
}

function score(answers) {
  const answered = Object.values(answers);
  return answered.length ? answered.filter((a) => a.firstCorrect).length / answered.length : null;
}

async function lessonReply(p, lesson) {
  const lang = p.language;
  const L = hasNative(lang) ? lang : 'en';
  const c = content(lesson, L);
  const en = content(lesson, 'en');
  const build = (x, header) => `${header}\n\n${x.tip}\n\n❓ ${x.question}`;
  let text = build(c, t(L, 'lesson_intro'));
  let labels = c.options.map((o) => o.label);
  if (!hasNative(lang)) {
    text = await localize(lang, text);
    labels = await Promise.all(labels.map((l) => localize(lang, l)));
  }
  return {
    text,
    textEn: build(en, t('en', 'lesson_intro')),
    buttons: labels.map((label, i) => [{ label, data: `lesson:${lesson.id}:${i}` }]),
  };
}

scheduler.defineJob('lesson_due', {
  skipIf: skipDuringRedLock,
  collapse: true,
  async run(job) {
    const p = store.getPatient(job.patientId);
    const lesson = nextLesson(p);
    if (!lesson) return { skipped: 'all lessons done' };
    const s = state(p);
    store.updatePatient(p.id, {
      lessons: { ...s, sent: s.sent.includes(lesson.id) ? s.sent : [...s.sent, lesson.id], queue: s.queue.filter((id) => id !== lesson.id) },
    });
    await channels.sendToPatient(store.getPatient(p.id), await lessonReply(p, lesson));
    store.audit('lesson_sent', p.id, { lesson: lesson.id });
    return { lesson: lesson.id };
  },
});

addPlanner((p, fromMs, toMs) => {
  for (const { at, key } of occurrences([LESSON_TIME], fromMs, toMs, tzOf(p))) {
    if (!isMonitored(p, at)) continue;
    scheduler.schedule({ kind: 'lesson_due', patientId: p.id, dueAt: at, key: `lesson_due:${p.id}:${key}` });
  }
});

// Handle a lesson:* tap. Returns Reply[].
export function handleButton(patient, data) {
  const [, id, idx] = data.split(':');
  const lesson = byId(id);
  const lang = hasNative(patient.language) ? patient.language : 'en';
  const both = (key, vars) => ({ text: t(lang, key, vars), textEn: t('en', key, vars) });
  if (!lesson) return [both('med_already')];

  const s = state(patient);
  const prev = s.answers[id];
  if (prev?.correct || (prev?.attempts ?? 0) >= MAX_ATTEMPTS) return [both('med_already')];

  const option = content(lesson, 'en').options[Number(idx)];
  if (!option) return [both('med_already')];
  const correct = !!option.correct;
  const answer = { attempts: (prev?.attempts ?? 0) + 1, correct, firstCorrect: prev ? prev.firstCorrect : correct, answeredAt: clock.nowISO() };
  const answers = { ...s.answers, [id]: answer };
  // Wrong on the first try: bring it back once more later (teach-back).
  const queue = !correct && answer.attempts < MAX_ATTEMPTS ? [...s.queue.filter((q) => q !== id), id] : s.queue.filter((q) => q !== id);
  store.updatePatient(patient.id, { lessons: { ...s, answers, queue, score: score(answers) } });
  store.audit('lesson_answer', patient.id, { lesson: id, correct, attempt: answer.attempts });

  const explain = { text: content(lesson, lang).explain, textEn: content(lesson, 'en').explain };
  const head = both(correct ? 'lesson_right' : 'lesson_wrong');
  return [{ text: `${head.text} ${explain.text}`, textEn: `${head.textEn} ${explain.textEn}` }];
}
