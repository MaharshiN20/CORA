// Refill-gap detection (P1-4). An unfilled discharge prescription is one of the
// biggest invisible drivers of readmission, and for heart failure the water pill
// matters most. We don't just nag; we ask what's in the way and turn the answer
// into help.
//
//   refill_check job (daily 10:00): any prescription still unfilled 48h after its
//   expected pickup gets a nudge (max 1/day, 3 total) asking what's in the way:
//     rx:<med>:picked | rx:<med>:ride | rx:<med>:cost | rx:<med>:other
//   ride/cost/other -> barrier stored + resource message + nurse task (kind 'refill';
//   YELLOW for the diuretic, INFO otherwise). No answer after 2 nudges -> nurse task.
//
// prescription = { med, expectedPickup, pickedUpAt, barrier?, nudges?: [iso], escalatedAt? }
import * as store from '../store.js';
import * as clock from './clock.js';
import * as scheduler from './scheduler.js';
import * as channels from '../channels/index.js';
import { t } from './i18n.js';
import { addPlanner, occurrences, isMonitored, tzOf } from './planning.js';
import { skipDuringRedLock } from './escalation.js';

const GRACE_MS = 48 * clock.HOUR;
const MIN_GAP_MS = 20 * clock.HOUR; // at most one nudge per day
const MAX_NUDGES = 3;
const ESCALATE_AFTER = 2;
const CHECK_TIME = '10:00';

const BARRIERS = { ride: 'transport', cost: 'cost', other: 'other' };
const SDOH_FLAG = { transport: 'transportation', cost: 'medication_cost' };

const isDiuretic = (p, med) => !!p.meds?.find((m) => m.name === med)?.diuretic;
const both = (p, key, vars) => ({ text: t(p.language, key, vars), textEn: t('en', key, vars) });

export function overdue(p, now = clock.now()) {
  return (p.prescriptions ?? []).filter((rx) => !rx.pickedUpAt && Date.parse(rx.expectedPickup) + GRACE_MS <= now);
}

// ---------- scheduling ----------

scheduler.defineJob('refill_check', {
  skipIf: skipDuringRedLock,
  collapse: true,
  async run(job) {
    const p = store.getPatient(job.patientId);
    const now = clock.now();
    const nudged = [];
    const prescriptions = (p.prescriptions ?? []).map((rx) => ({ ...rx }));

    for (const rx of prescriptions) {
      if (rx.pickedUpAt || Date.parse(rx.expectedPickup) + GRACE_MS > now) continue;
      if (rx.barrier || rx.escalatedAt) continue; // a nurse task owns it now: stop messaging the patient
      const nudges = rx.nudges ?? [];
      if (nudges.length >= MAX_NUDGES) continue;
      if (nudges.length && now - Date.parse(nudges.at(-1)) < MIN_GAP_MS) continue;

      // Two nudges ignored: stop asking the patient, hand it to a nurse (once).
      if (nudges.length >= ESCALATE_AFTER && !rx.escalatedAt) {
        rx.escalatedAt = clock.nowISO();
        addRefillTask(p, rx.med, 'no_response');
        continue;
      }
      rx.nudges = [...nudges, clock.nowISO()];
      nudged.push(rx.med);
    }

    store.updatePatient(p.id, { prescriptions });
    const fresh = store.getPatient(p.id);
    for (const med of nudged) {
      await channels.sendToPatient(fresh, nudgeReply(fresh, med));
      store.audit('refill_nudge', p.id, { med, nudge: prescriptions.find((r) => r.med === med).nudges.length });
    }
    return { nudged };
  },
});

addPlanner((p, fromMs, toMs) => {
  if (!(p.prescriptions ?? []).some((rx) => !rx.pickedUpAt)) return;
  for (const { at, key } of occurrences([CHECK_TIME], fromMs, toMs, tzOf(p))) {
    if (!isMonitored(p, at)) continue;
    scheduler.schedule({ kind: 'refill_check', patientId: p.id, dueAt: at, key: `refill_check:${p.id}:${key}` });
  }
});

// Button data is capped at 64 bytes by Telegram and split on ":", so a long, accented or
// colon-containing medication name can't ride inside it. Those use the prescription's position
// instead ("rx:#2:picked"). Short plain names keep the old form, which old chat messages use too.
function rxKey(p, med) {
  const plain = Buffer.byteLength(`rx:${med}:other`) <= 64 && !med.includes(':') && !med.startsWith('#');
  return plain ? med : `#${p.prescriptions.findIndex((r) => r.med === med)}`;
}
function rxFromKey(p, key) {
  if (key?.startsWith('#')) return p.prescriptions?.[Number(key.slice(1))] ?? null;
  return p.prescriptions?.find((r) => r.med === key) ?? null;
}

function nudgeReply(p, med) {
  const L = p.language;
  const k = rxKey(p, med);
  return {
    ...both(p, 'rx_nudge', { med }),
    buttons: [
      [{ label: t(L, 'rx_picked'), data: `rx:${k}:picked` }],
      [{ label: t(L, 'rx_ride'), data: `rx:${k}:ride` }, { label: t(L, 'rx_cost'), data: `rx:${k}:cost` }],
      [{ label: t(L, 'rx_other'), data: `rx:${k}:other` }],
    ],
  };
}

// ---------- answers ----------

function addRefillTask(p, med, barrier) {
  const reasonKey = { transport: 'needs a ride to the pharmacy', cost: 'says it costs too much', other: 'reported another problem', no_response: 'no reply to 2 reminders' }[barrier];
  return store.addTask({
    patientId: p.id,
    kind: 'refill',
    tier: isDiuretic(p, med) ? 'YELLOW' : 'INFO',
    title: `${med} not picked up: ${reasonKey}`,
    reasons: [`${med} prescription unfilled since ${new Date(p.prescriptions.find((r) => r.med === med).expectedPickup).toLocaleDateString()}`, `Barrier: ${reasonKey}`],
    med,
    barrier,
  });
}

export function markPickedUp(patientId, med, { by = 'patient' } = {}) {
  const p = store.getPatient(patientId);
  const rx = p?.prescriptions?.find((r) => r.med.toLowerCase() === String(med).toLowerCase());
  if (!rx) return null;
  const prescriptions = p.prescriptions.map((r) => (r === rx ? { ...r, pickedUpAt: clock.nowISO() } : r));
  store.updatePatient(p.id, { prescriptions });
  // Close any open refill task for this med.
  for (const a of store.listAlerts(p.id)) {
    if (a.kind === 'refill' && a.med === rx.med && a.status !== 'resolved') {
      store.updateAlert(a.id, { status: 'resolved', outcome: 'other', note: `Pickup confirmed by ${by}`, by });
    }
  }
  store.audit('refill_picked_up', p.id, { med: rx.med, by });
  return store.getPatient(p.id).prescriptions.find((r) => r.med === rx.med);
}

// Handle an rx:* button tap. Returns Reply[].
export function handleButton(patient, data) {
  const [, key, choice] = data.split(':');
  const rx = rxFromKey(patient, key);
  if (!rx) return [both(patient, 'med_already')];
  const med = rx.med;

  if (choice === 'picked') {
    markPickedUp(patient.id, med);
    return [both(patient, 'rx_thanks', { med })];
  }

  const barrier = BARRIERS[choice];
  if (!barrier) return [both(patient, 'med_already')];
  if (rx.barrier === barrier) return [both(patient, 'med_already')];

  const flags = new Set(patient.sdoh?.flags ?? []);
  if (SDOH_FLAG[barrier]) flags.add(SDOH_FLAG[barrier]);
  store.updatePatient(patient.id, {
    prescriptions: patient.prescriptions.map((r) => (r === rx ? { ...r, barrier, barrierAt: clock.nowISO() } : r)),
    sdoh: { ...(patient.sdoh ?? {}), flags: [...flags] },
  });
  addRefillTask(store.getPatient(patient.id), med, barrier);
  store.audit('refill_barrier', patient.id, { med, barrier });
  return [both(patient, `rx_help_${choice}`, { med })];
}
