// Turns a triage result into actions: alert record, nurse group message, caregiver message.
// GREEN does nothing here; the patient just gets advice.
import * as store from '../store.js';
import * as channels from '../channels/index.js';
import * as clock from './clock.js';
import { t, hasNative, localizeUrgent } from './i18n.js';

const ICON = { RED: '🚨', YELLOW: '⚠️' };

// ---------- RED lock ----------
// After a patient is told to call 911, nothing else may distract them: no next question, no
// tips, no "I can help with…" answers. For RED_LOCK_MS after a RED triage alert, or until a
// nurse resolves it, every inbound message re-asserts 911 and is appended to that alert.
export const RED_LOCK_MS = 60 * 60 * 1000;

// -> the open RED triage alert holding the lock, or null.
export function redLock(patient) {
  const now = clock.now();
  return (
    store
      .listAlerts(patient.id)
      .find((a) => a.tier === 'RED' && (a.kind ?? 'triage') === 'triage' && a.status !== 'resolved' && now - Date.parse(a.ts) < RED_LOCK_MS) ?? null
  );
}

// Scheduler skipIf for routine patient messages (check-ins, lessons, screens, reminders):
// nothing but "call 911" while the lock holds.
export function skipDuringRedLock(job) {
  const p = job.patientId && store.getPatient(job.patientId);
  return p && redLock(p) ? 'RED lock: patient was told to call 911' : null;
}

// Record a message that arrived during the lock on the RED alert itself (one incident, not a
// second card) and nudge the nurses. `note` flags anything the nurse must see (a med question).
export async function appendToRedAlert(patient, alert, { who = 'Patient', text, note } = {}) {
  const at = new Date(clock.now()).toTimeString().slice(0, 5);
  const said = text ? `: "${String(text).slice(0, 160)}"` : '';
  const reason = `${who} messaged again at ${at}${said}${note ? ` (${note})` : ''}`;
  store.updateAlert(alert.id, { reasons: [...(alert.reasons ?? []), reason] });
  store.audit('red_lock', patient.id, { alertId: alert.id, who, text: text ?? null, note: note ?? null });
  await channels.sendToNurses({ patientId: patient.id, text: `🚨 RED follow-up: ${patient.name}. ${reason}. Patient was told to call 911.` });
}

// reporter: 'patient' | 'caregiver' (proxy check-in). A caregiver who just reported
// the answers isn't sent an alert about them; the nurse is told who reported.
export async function escalate(patient, result, { source = 'check-in', reporter = 'patient' } = {}) {
  if (result.tier === 'GREEN') return null;

  const reasons = result.flags.map((f) => f.text);
  // A summary title for scanning the worklist; the reasons list carries the detail.
  const n = reasons.length;
  const title =
    result.tier === 'RED'
      ? `Possible emergency: told to call 911 (${reasons[0]}${n > 1 ? ` +${n - 1} more` : ''})`
      : `Nurse call today: ${n} warning sign${n === 1 ? '' : 's'}`;
  const alert = store.addAlert({ patientId: patient.id, tier: result.tier, title, reasons, source, priority: result.priority, reporter });

  const action = result.tier === 'RED' ? 'Patient told to call 911. Call patient NOW.' : 'Nurse callback needed today.';
  const who = reporter === 'caregiver' ? `\nReported by caregiver ${patient.caregiver?.name ?? ''} (${patient.caregiver?.relation ?? 'family'})` : '';
  const nurseMsg =
    `${ICON[result.tier]} ${result.tier}: ${patient.name} (${patient.age}y, ${patient.riskTier ?? '?'} risk)\n` +
    reasons.map((r) => `• ${r}`).join('\n') +
    `\n${action}\nSource: ${source}${who}`;
  await channels.sendToNurses({ text: nurseMsg, patientId: patient.id, alertId: alert.id });

  if (reporter !== 'caregiver' && patient.caregiverConsent !== false) {
    const first = patient.name.split(' ')[0];
    // Family gets plain language: drop the clinical thresholds in parentheses.
    const plain = reasons.map((r) => r.replace(/\s*\(.*?\)/g, '')).join('; ');
    // In the caregiver's language (the clinical reasons stay as the care team wrote them).
    const key = result.tier === 'RED' ? 'cg_alert_red' : 'cg_alert_yellow';
    const vars = { name: first, reasons: plain };
    const lang = patient.caregiver?.language ?? 'en';
    const textEn = t('en', key, vars);
    const text = hasNative(lang) ? t(lang, key, vars) : await localizeUrgent(lang, textEn);
    await channels.sendToCaregiver(patient, { text, textEn });
  }

  return alert;
}
