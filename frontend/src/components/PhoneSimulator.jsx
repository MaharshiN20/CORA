// A phone-shaped chat that talks to the backend exactly like Telegram would, through
// POST /api/patients/:id/simulate. Works with no Telegram at all (demo backup).
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Button } from './ui.jsx';

// Only the latest bot message to this role has live buttons (like Telegram), and only until
// the person answers it some other way (typing), so a question can't be answered twice.
export function liveButtonIndex(messages, role) {
  const lastOut = messages.findLastIndex((m) => m.direction === 'out' && (m.to ?? 'patient') === role);
  if (lastOut < 0) return -1;
  return messages.slice(lastOut + 1).some((m) => m.direction === 'in') ? -1 : lastOut;
}

export function ChatLog({ messages, role = 'patient', tappable = true, showEnglish = true, onTap }) {
  const live = liveButtonIndex(messages, role);
  return (
    <div className="flex flex-col gap-1.5">
      {messages.length === 0 && <p className="py-6 text-center text-sm text-slate-400">No messages yet.</p>}
      {messages.map((m, i) => {
        const inbound = m.direction === 'in';
        const toCaregiver = m.to === 'caregiver';
        return (
          <div
            key={m.id ?? i}
            className={`bubble-in max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${inbound ? 'self-end bg-blue-600 text-white' : toCaregiver ? 'self-start bg-violet-100 text-violet-950' : m.to === 'nurse' ? 'self-start bg-amber-50 text-amber-950' : 'self-start bg-slate-100 text-slate-900'} ${/🚨/.test(m.text ?? '') && !inbound ? 'ring-2 ring-red-500' : ''}`}
          >
            {toCaregiver && <div className="mb-0.5 text-[11px] font-semibold uppercase opacity-70">→ caregiver</div>}
            {m.to === 'nurse' && <div className="mb-0.5 text-[11px] font-semibold uppercase opacity-70">→ nurse</div>}
            {inbound && m.from === 'caregiver' && <div className="mb-0.5 text-[11px] font-semibold uppercase opacity-80">caregiver</div>}
            {m.text}
            {showEnglish && m.textEn && m.textEn !== m.text && <div className={`mt-1 border-t pt-1 text-xs ${inbound ? 'border-white/30 text-white/80' : 'border-slate-300 text-slate-500'}`}>EN: {m.textEn}</div>}
            {m.buttons?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {m.buttons.flat().map((b) => (
                  <button
                    key={b.data}
                    disabled={!tappable || i !== live || !onTap}
                    onClick={() => onTap?.(b.data)}
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
    </div>
  );
}

// Three bouncing dots while the bot is "typing" (the reply can take a few seconds with an AI).
export const TypingDots = () => (
  <div className="bubble-in self-start rounded-2xl bg-slate-100 px-3 py-2.5" aria-label="HeartBridge is typing" role="status">
    <span className="flex gap-1">
      {[0, 150, 300].map((d) => (
        <span key={d} className="h-2 w-2 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: `${d}ms` }} />
      ))}
    </span>
  </div>
);

// Shrink a photo before upload (phones take 4000px images; the bot needs a readable label).
async function photoPayload(file, maxSide = 1280) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not read that image'));
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return { base64: canvas.toDataURL('image/jpeg', 0.85).split(',')[1], mime: 'image/jpeg' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function PhoneSimulator({ patient, messages, role = 'patient', onRoleChange, compact = false }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const box = useRef(null);
  const file = useRef(null);
  const shown = messages.filter((m) => (role === 'caregiver' ? m.to === 'caregiver' || m.from === 'caregiver' : m.to !== 'caregiver' && m.from !== 'caregiver' && m.to !== 'nurse'));

  // Scroll the chat box itself (scrollIntoView scrolled the whole page to the bottom).
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown.length, busy]);

  // Every way of answering (text, tap, photo) goes through here: one request at a time,
  // failures shown inline, never an unhandled rejection.
  const deliver = async (body, { restore } = {}) => {
    setBusy(true);
    setError(null);
    try {
      await api.simulate(patient.id, { ...body, role });
    } catch (err) {
      restore?.();
      setError(err.status ? `Not sent: ${err.message}` : 'Not sent: the server is unreachable. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  // Clear the box as soon as the message is sent (like a real chat app); on failure it comes back.
  const send = (e) => {
    e.preventDefault();
    const text = draft;
    if (!text.trim() || busy) return;
    setDraft('');
    deliver({ text }, { restore: () => setDraft((current) => current || text) });
  };

  const tap = (buttonData) => !busy && deliver({ buttonData });

  const pickPhoto = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      deliver({ photo: await photoPayload(f) });
    } catch (err) {
      setError(err.message);
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
      <div ref={box} className="flex flex-1 flex-col gap-1.5 overflow-y-auto bg-slate-50 p-3" data-testid="chat-box">
        <ChatLog messages={shown} role={role} tappable={!busy} onTap={tap} />
        {busy && <TypingDots />}
      </div>
      {error && (
        <p role="alert" className="border-t border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-800">
          {error}
        </p>
      )}
      <form onSubmit={send} className="flex gap-2 border-t border-slate-200 p-2">
        <input ref={file} type="file" accept="image/*" className="hidden" onChange={pickPhoto} aria-label="Photo" />
        {role === 'patient' && (
          <button type="button" onClick={() => file.current?.click()} disabled={busy} title="Send a photo (scale, pill bottle)" aria-label="Send a photo" className="rounded-full px-2 text-lg disabled:opacity-40">
            📷
          </button>
        )}
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={role === 'caregiver' ? 'Message as caregiver…' : 'Message as patient…'} className="min-w-0 flex-1 rounded-full border border-slate-300 px-3 py-1.5 text-sm" />
        <Button disabled={busy || !draft.trim()} className="rounded-full">
          Send
        </Button>
      </form>
    </div>
  );
}
