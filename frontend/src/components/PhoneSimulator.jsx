// A phone-shaped chat that talks to the backend exactly like Telegram would, through
// POST /api/patients/:id/simulate. Works with no Telegram at all (demo backup).
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Button } from './ui.jsx';

export function ChatLog({ messages, patientId, role = 'patient', tappable = true, showEnglish = true }) {
  const end = useRef(null);
  // Braces matter: newer Chrome returns a Promise from scrollIntoView, which React would
  // treat as a (broken) cleanup function.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);
  // Only the latest bot message to this role has live buttons, like Telegram.
  const lastIdx = messages.findLastIndex((m) => m.direction === 'out' && (m.to ?? 'patient') === role);
  return (
    <div className="flex flex-col gap-1.5">
      {messages.length === 0 && <p className="py-6 text-center text-sm text-slate-400">No messages yet.</p>}
      {messages.map((m, i) => {
        const inbound = m.direction === 'in';
        const toCaregiver = m.to === 'caregiver';
        return (
          <div key={m.id ?? i} className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${inbound ? 'self-end bg-blue-600 text-white' : toCaregiver ? 'self-start bg-violet-100 text-violet-950' : m.to === 'nurse' ? 'self-start bg-amber-50 text-amber-950' : 'self-start bg-slate-100 text-slate-900'}`}>
            {toCaregiver && <div className="mb-0.5 text-[11px] font-semibold uppercase opacity-70">→ caregiver</div>}
            {inbound && m.from === 'caregiver' && <div className="mb-0.5 text-[11px] font-semibold uppercase opacity-80">caregiver</div>}
            {m.text}
            {showEnglish && m.textEn && m.textEn !== m.text && <div className={`mt-1 border-t pt-1 text-xs ${inbound ? 'border-white/30 text-white/80' : 'border-slate-300 text-slate-500'}`}>EN: {m.textEn}</div>}
            {m.buttons?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {m.buttons.flat().map((b) => (
                  <button
                    key={b.data}
                    disabled={!tappable || i !== lastIdx}
                    onClick={() => api.simulate(patientId, { buttonData: b.data, role })}
                    className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-blue-700 ring-1 ring-blue-300 enabled:hover:bg-blue-50 disabled:opacity-50"
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}

export default function PhoneSimulator({ patient, messages, role = 'patient', onRoleChange, compact = false }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = messages.filter((m) => (role === 'caregiver' ? m.to === 'caregiver' || m.from === 'caregiver' : m.to !== 'caregiver' && m.from !== 'caregiver'));

  const send = async (e) => {
    e.preventDefault();
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await api.simulate(patient.id, { text: draft, role });
      setDraft('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`mx-auto flex w-full flex-col overflow-hidden rounded-[2rem] border-8 border-slate-800 bg-white shadow-xl ${compact ? 'h-[28rem] max-w-sm' : 'h-[36rem] max-w-md'}`}>
      <div className="flex items-center justify-between bg-slate-800 px-4 pb-2 text-white">
        <span className="text-sm font-semibold">💙 HeartBridge</span>
        {onRoleChange && (
          <select aria-label="Chat as" value={role} onChange={(e) => onRoleChange(e.target.value)} className="rounded bg-slate-700 px-1 text-xs">
            <option value="patient">as {patient.name.split(' ')[0]}</option>
            <option value="caregiver">as caregiver{patient.caregiver?.name ? ` (${patient.caregiver.name.split(' ')[0]})` : ''}</option>
          </select>
        )}
      </div>
      <div className="flex-1 overflow-y-auto bg-slate-50 p-3">
        <ChatLog messages={shown} patientId={patient.id} role={role} />
      </div>
      <form onSubmit={send} className="flex gap-2 border-t border-slate-200 p-2">
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={role === 'caregiver' ? 'Message as caregiver…' : 'Message as patient…'} className="flex-1 rounded-full border border-slate-300 px-3 py-1.5 text-sm" />
        <Button disabled={busy || !draft.trim()} className="rounded-full">
          Send
        </Button>
      </form>
    </div>
  );
}
