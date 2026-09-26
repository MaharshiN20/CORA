// ============================================================================
// THE CONTRACT between any messaging channel (Telegram today) and the core logic.
//
//   handleInbound({ patientId, text?, buttonData?, voiceTranscript? })
//     -> Promise<Reply[]>
//
//   Reply = { text: string, buttons?: Button[][] }   // rows of buttons
//   Button = { label: string, data: string }         // data comes back as buttonData (<= 64 bytes)
//
// The channel layer only has to: identify the patient, call this, and render
// the replies. It never makes clinical decisions.
//
// STATUS: stub. Echoes input and returns sample buttons so the Telegram layer
// can be built and tested end-to-end before the real check-in engine lands.
// ============================================================================
import * as store from '../store.js';

export async function handleInbound({ patientId, text, buttonData, voiceTranscript }) {
  const patient = store.getPatient(patientId);
  if (!patient) return [{ text: 'Sorry, I could not find your record. Ask your care team for your link code.' }];

  const input = buttonData ?? voiceTranscript ?? text ?? '';
  store.addMessage({ patientId, direction: 'in', text: input });

  // TODO(core): replace with checkin.js state machine + triage.js
  const replies = [
    {
      text: `👋 Hi ${patient.name.split(' ')[0]}! (stub) You said: "${input}"\nHow is your breathing today?`,
      buttons: [
        [
          { label: '😊 Normal', data: 'breath:normal' },
          { label: '😮‍💨 Worse walking', data: 'breath:exertion' },
        ],
        [{ label: '🚨 Hard at rest', data: 'breath:rest' }],
      ],
    },
  ];

  for (const r of replies) store.addMessage({ patientId, direction: 'out', text: r.text });
  return replies;
}

// Called by the scheduler / dashboard to start a check-in proactively.
// Returns the first prompt(s); the caller sends them via channels.send().
export async function startCheckin(patientId) {
  const patient = store.getPatient(patientId);
  if (!patient) return [];
  // TODO(core): real first question from checkin.js
  return [{ text: `Good morning ${patient.name.split(' ')[0]}! Time for your daily check-in. What is your weight this morning (lb)?` }];
}
