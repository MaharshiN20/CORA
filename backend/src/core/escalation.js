// Turns a triage result into actions: alert record, nurse group message, caregiver message.
// GREEN does nothing here; the patient just gets advice.
import * as store from '../store.js';
import * as channels from '../channels/index.js';

const ICON = { RED: '🚨', YELLOW: '⚠️' };

export async function escalate(patient, result, { source = 'check-in' } = {}) {
  if (result.tier === 'GREEN') return null;

  const reasons = result.flags.map((f) => f.text);
  const alert = store.addAlert({ patientId: patient.id, tier: result.tier, reasons, source, priority: result.priority });

  const action = result.tier === 'RED' ? 'Patient told to call 911. Call patient NOW.' : 'Nurse callback needed today.';
  const nurseMsg =
    `${ICON[result.tier]} ${result.tier}: ${patient.name} (${patient.age}y, ${patient.riskTier ?? '?'} risk)\n` +
    reasons.map((r) => `• ${r}`).join('\n') +
    `\n${action}\nSource: ${source}`;
  await channels.sendToNurses({ text: nurseMsg });

  const first = patient.name.split(' ')[0];
  // Family gets plain language: drop the clinical thresholds in parentheses.
  const plain = reasons.map((r) => r.replace(/\s*\(.*?\)/g, '')).join('; ');
  const cgMsg =
    result.tier === 'RED'
      ? `🚨 HeartBridge alert for ${first}: ${plain}. ${first} has been told to call 911 and the care team was alerted. Please check on ${first} right away.`
      : `⚠️ HeartBridge update for ${first}: ${plain}. A nurse will call ${first} today. You may want to check in.`;
  await channels.sendToCaregiver(patient, { text: cgMsg });

  return alert;
}
