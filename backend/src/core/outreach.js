// Non-response escalation ladder (P1-5). Silence is itself a warning sign, and
// patient drop-off is exactly why big telemonitoring trials (Tele-HF, BEAT-HF) failed.
//
// When a check-in goes out, three rungs are scheduled:
//   +2h  gentle reminder to the patient (re-asks the current question)
//   +6h  caregiver: "Maria hasn't answered, can you check on her?" + [Answer for her]
//   +24h nurse worklist task kind 'unreachable' (YELLOW) + nurse group message
// Any reply from the patient cancels the remaining rungs. If some had already fired,
// it's logged as a recovery (`outreach_recovered`), which the impact metrics use.
//
// A rung fires only if the patient hasn't replied since the ladder started (not
// "same check-in session"), so day 1's 24h rung still fires when day 2's check-in
// starts at the same moment. Repeated silence bumps one open 'unreachable' task
// instead of stacking duplicates.
import * as store from '../store.js';
import * as clock from './clock.js';
import * as scheduler from './scheduler.js';
import * as channels from '../channels/index.js';
import { t } from './i18n.js';
import { currentPrompt } from './checkin.js';

export const RUNGS = [
  { rung: 1, afterMs: 2 * clock.HOUR, name: 'patient_reminder' },
  { rung: 2, afterMs: 6 * clock.HOUR, name: 'caregiver' },
  { rung: 3, afterMs: 24 * clock.HOUR, name: 'nurse' },
];

const firstName = (p) => p.name.split(' ')[0];

// Called right after a check-in is sent to the patient.
export function startLadder(patient, startedAtIso = clock.nowISO()) {
  const start = Date.parse(startedAtIso);
  for (const r of RUNGS) {
    scheduler.schedule({
      kind: 'outreach_step',
      patientId: patient.id,
      dueAt: start + r.afterMs,
      key: `outreach:${patient.id}:${startedAtIso}:${r.rung}`,
      payload: { rung: r.rung, ladderStart: startedAtIso },
    });
  }
  store.audit('outreach', patient.id, { event: 'ladder_started', ladderStart: startedAtIso });
}

// Called for every inbound patient message (and when a caregiver answers for them):
// cancel pending rungs, record a recovery. via: 'patient' | 'caregiver'.
export function onPatientReply(patient, { via = 'patient' } = {}) {
  const fired = scheduler.listJobs({ kind: 'outreach_step', patientId: patient.id, status: 'done' }).filter(
    (j) => j.result?.fired && Date.parse(j.payload.ladderStart) > Date.parse(patient.lastRecoveryCheck ?? 0),
  );
  const cancelled = scheduler.cancel({ kind: 'outreach_step', patientId: patient.id });
  if (fired.length) {
    store.audit('outreach_recovered', patient.id, { afterRung: Math.max(...fired.map((j) => j.payload.rung)), rungsFired: fired.length, via });
  }
  store.updatePatient(patient.id, { lastReplyAt: clock.nowISO(), lastRecoveryCheck: clock.nowISO() });
  return { cancelled, recovered: fired.length > 0 };
}

const repliedSince = (p, iso) => p.lastReplyAt && Date.parse(p.lastReplyAt) >= Date.parse(iso);

scheduler.defineJob('outreach_step', {
  async run(job) {
    const p = store.getPatient(job.patientId);
    const { rung, ladderStart } = job.payload;
    if (repliedSince(p, ladderStart)) return { fired: false, reason: 'patient replied' };

    if (rung === 1) {
      const msgs = [
        { text: t(p.language, 'outreach_reminder', { name: firstName(p) }), textEn: t('en', 'outreach_reminder', { name: firstName(p) }) },
      ];
      const prompt = currentPrompt(p);
      if (prompt) msgs.push(prompt);
      for (const m of msgs) await channels.sendToPatient(p, m);
    }

    if (rung === 2) {
      const cg = p.caregiver;
      if (!cg?.name || p.caregiverConsent === false) {
        store.audit('outreach', p.id, { event: 'rung', rung, skipped: 'no consented caregiver' });
        return { fired: false, reason: 'no consented caregiver' };
      }
      const L = cg.language ?? 'en';
      await channels.sendToCaregiver(p, {
        text: t(L, 'outreach_caregiver', { name: firstName(p) }),
        textEn: t('en', 'outreach_caregiver', { name: firstName(p) }),
        buttons: [[{ label: t(L, 'outreach_proxy_btn', { name: firstName(p) }), data: 'cmd:proxy' }]],
      });
    }

    if (rung === 3) {
      const open = store
        .listAlerts()
        .find((a) => a.patientId === p.id && a.kind === 'unreachable' && a.status !== 'resolved');
      const reason = `No reply to the check-in sent ${new Date(ladderStart).toLocaleString()}`;
      if (open) {
        store.updateAlert(open.id, { reasons: [...open.reasons, reason], silentDays: (open.silentDays ?? 1) + 1 });
      } else {
        store.addTask({
          patientId: p.id,
          kind: 'unreachable',
          tier: 'YELLOW',
          title: `No response for 24h`,
          reasons: [reason, 'Reminder sent at +2h; caregiver contacted at +6h'],
          silentDays: 1,
        });
        await channels.sendToNurses({ text: `⚠️ UNREACHABLE: ${p.name} hasn't answered for 24h (reminder + caregiver already tried). Please call.` });
      }
    }

    store.audit('outreach', p.id, { event: 'rung', rung, ladderStart });
    return { fired: true, rung };
  },
});
