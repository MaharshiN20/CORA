// Answer a running check-in step by step, whatever questions the patient's (live) risk
// plan asks. Risk v2 adds questions as a patient gets riskier, so scripted fixed-length
// answer lists break; this answers the current step until the check-in finishes.
//
//   await completeCheckin(agent, store, 'p5', { diuretic: 'ci:diu:no' })
//   overrides: { weight: '140', breath: 'ci:breath:rest', ... } per step id
export const DEFAULT_ANSWERS = {
  breath: 'ci:breath:normal',
  orthopnea: 'ci:orth:no',
  swelling: 'ci:swell:none',
  redflags: 'ci:rf:none',
  diuretic: 'ci:diu:yes',
  spo2: 'ci:spo2:none',
};

export async function completeCheckin(agent, store, patientId, overrides = {}, { role = 'patient', maxSteps = 12 } = {}) {
  let replies = [];
  for (let i = 0; i < maxSteps; i++) {
    const p = store.getPatient(patientId);
    const step = p.checkin?.state;
    if (!step || step === 'idle') return replies;
    const answer = overrides[step] ?? (step === 'weight' ? String(p.weights.at(-1)?.lb ?? 150) : DEFAULT_ANSWERS[step]);
    const input = answer.startsWith('ci:') ? { buttonData: answer } : { text: answer };
    replies = await agent.handleInbound({ patientId, role, ...input });
  }
  throw new Error(`check-in for ${patientId} did not finish in ${maxSteps} steps`);
}
