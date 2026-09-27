// P2-9: teach-back micro-lessons.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-lessons-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, clock, jobs, scheduler, agent, planning, signals, LESSONS;
before(async () => {
  store = await import('../src/store.js');
  clock = await import('../src/core/clock.js');
  jobs = await import('../src/core/jobs.js');
  scheduler = await import('../src/core/scheduler.js');
  agent = await import('../src/core/agent.js');
  planning = await import('../src/core/planning.js');
  signals = await import('../src/core/signals.js');
  ({ LESSONS } = await import('../src/conditions/chf/lessons.js'));
});
beforeEach(async () => {
  jobs.stop();
  store.reset();
  const six = planning.occurrences(['06:00'], clock.now(), clock.now() + clock.DAY)[0].at;
  clock.advance(six - clock.now());
  await jobs.start({ intervalMs: 0 });
});

async function nextDay5pm() {
  const at = planning.occurrences(['17:00'], clock.now(), clock.now() + clock.DAY)[0].at;
  const by = at - clock.now() + 60_000;
  clock.advance(by);
  await jobs.afterAdvance(by);
}
const lessonMsgs = (id) => store.listMessages(id).filter((m) => m.buttons?.flat().some((b) => b.data.startsWith('lesson:')));
const lastLesson = (id) => lessonMsgs(id).at(-1);
const tap = (id, data) => agent.handleInbound({ patientId: id, buttonData: data });
const optionData = (msg, correct) => {
  const lessonId = msg.buttons[0][0].data.split(':')[1];
  const opts = LESSONS.find((l) => l.id === lessonId).en.options;
  const i = opts.findIndex((o) => !!o.correct === correct);
  return `lesson:${lessonId}:${i}`;
};

test('17:00: first lesson arrives with the tip, a question and answer buttons', async () => {
  await nextDay5pm();
  const m = lastLesson('p5');
  assert.match(m.text, /1-minute heart tip/);
  assert.match(m.text, /If you gain 3 lb/);
  assert.equal(m.buttons.length, 3);
  assert.ok(m.buttons.flat().every((b) => Buffer.byteLength(b.data) <= 64));
});

test('Spanish patient gets the Spanish lesson with an English twin', async () => {
  await nextDay5pm();
  const m = lastLesson('p1');
  assert.match(m.text, /Consejo del corazón/);
  assert.match(m.textEn, /1-minute heart tip/);
});

test('right answer -> reinforcement + score 1; the lesson never comes back', async () => {
  await nextDay5pm();
  const r = await tap('p5', optionData(lastLesson('p5'), true));
  assert.match(r[0].text, /That's right!.*same day/);
  assert.equal(store.getPatient('p5').lessons.score, 1);
  await nextDay5pm();
  assert.match(lastLesson('p5').textEn, /most salt/); // moved on to lesson 2
});

test('wrong answer -> explanation, and the lesson comes back once (teach-back)', async () => {
  await nextDay5pm();
  const r = await tap('p5', optionData(lastLesson('p5'), false));
  assert.match(r[0].text, /Not quite.*2 lb in a day/);
  assert.equal(store.getPatient('p5').lessons.score, 0);
  await nextDay5pm();
  assert.match(lastLesson('p5').textEn, /If you gain 3 lb/); // retry comes before new lessons
  await tap('p5', optionData(lastLesson('p5'), true));
  const s = store.getPatient('p5').lessons;
  assert.equal(s.answers.weigh.attempts, 2);
  assert.equal(s.answers.weigh.firstCorrect, false); // score is about first-try understanding
  assert.equal(s.score, 0);
  await nextDay5pm();
  assert.match(lastLesson('p5').textEn, /most salt/);
});

test('double taps and taps on finished lessons are ignored', async () => {
  await nextDay5pm();
  const right = optionData(lastLesson('p5'), true);
  await tap('p5', right);
  const again = await tap('p5', right);
  assert.match(again[0].text, /Already/);
  assert.equal(store.getPatient('p5').lessons.answers.weigh.attempts, 1);
});

test('score feeds signals.lessonScore', async () => {
  await nextDay5pm();
  await tap('p5', optionData(lastLesson('p5'), true));
  await nextDay5pm();
  await tap('p5', optionData(lastLesson('p5'), false));
  assert.equal(signals.getSignals(store.getPatient('p5')).lessonScore, 0.5);
});

test('a 5-day jump sends one lesson, not five', async () => {
  clock.advance(5 * clock.DAY);
  await jobs.afterAdvance(5 * clock.DAY);
  assert.equal(lessonMsgs('p5').length, 1);
  assert.ok(scheduler.listJobs({ kind: 'lesson_due', patientId: 'p5', status: 'missed' }).length >= 3);
});

test('after the last lesson, no more are sent', async () => {
  store.updatePatient('p5', { lessons: { sent: LESSONS.map((l) => l.id), queue: [], answers: {}, score: null } });
  await nextDay5pm();
  assert.equal(lessonMsgs('p5').length, 0);
  const job = scheduler.listJobs({ kind: 'lesson_due', patientId: 'p5', status: 'done' })[0];
  assert.match(job.result.skipped, /all lessons done/);
});

test('every lesson has en + es, exactly one correct option, and matching option counts', () => {
  for (const l of LESSONS) {
    for (const lang of ['en', 'es']) {
      const c = l[lang];
      assert.ok(c.tip && c.question && c.explain, `${l.id} ${lang} incomplete`);
      assert.equal(c.options.filter((o) => o.correct).length, 1, `${l.id} ${lang} needs exactly one correct option`);
    }
    assert.equal(l.en.options.length, l.es.options.length, `${l.id}: en/es option counts differ`);
    l.en.options.forEach((o, i) => assert.equal(!!o.correct, !!l.es.options[i].correct, `${l.id}: correct option index differs`));
  }
});
