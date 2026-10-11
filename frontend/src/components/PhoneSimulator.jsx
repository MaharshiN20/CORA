// A phone-shaped chat that talks to the backend exactly like Telegram would, through
// POST /api/patients/:id/simulate. Works with no Telegram at all (demo backup).
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Camera, SendHorizontal } from 'lucide-react';

// Only the latest bot message to this role has live buttons (like Telegram), and only until
// the person answers it some other way (typing), so a question can't be answered twice.
export function liveButtonIndex(messages, role) {
  const lastOut = messages.findLastIndex((m) => m.direction === 'out' && (m.to ?? 'patient') === role);
  if (lastOut < 0) return -1;
  return messages.slice(lastOut + 1).some((m) => m.direction === 'in') ? -1 : lastOut;
}

// Who a message is "from" for bubble grouping: consecutive bubbles from the same side and
// audience merge into one run (tight corners inside the run, like Telegram / iMessage).
const sideOf = (m) => `${m.direction}:${m.to ?? ''}:${m.from ?? ''}`;

const BUBBLE = {
  in: 'bg-linear-to-b from-sky-500 to-blue-600 text-white shadow-sm shadow-blue-700/25',
  caregiver: 'bg-violet-50 text-violet-950 ring-1 ring-violet-200',
  nurse: 'bg-amber-50 text-amber-950 ring-1 ring-amber-200',
  bot: 'bg-white text-slate-900 shadow-[0_1px_1px_rgb(0_0_0/0.04)] ring-1 ring-black/5',
  // The 911 instruction is the most important message the bot ever sends: its own surface,
  // a label, and weight, not just a red outline on an ordinary bubble.
  emergency: 'bg-linear-to-b from-red-50 to-white text-red-950 ring-1 ring-red-300 shadow-md shadow-red-900/10',
};

export function ChatLog({ messages, role = 'patient', tappable = true, showEnglish = true, onTap }) {
  const live = liveButtonIndex(messages, role);
  return (
    <div className="flex flex-col">
      {messages.length === 0 && <p className="py-10 text-center text-sm text-slate-400">No messages yet. Start a check-in or type below.</p>}
      {messages.map((m, i) => {
        const inbound = m.direction === 'in';
        const toCaregiver = m.to === 'caregiver';
        const emergency = !inbound && /🚨/.test(m.text ?? '');
        const first = i === 0 || sideOf(messages[i - 1]) !== sideOf(m);
        const kind = inbound ? 'in' : emergency ? 'emergency' : toCaregiver ? 'caregiver' : m.to === 'nurse' ? 'nurse' : 'bot';
        // Rounded everywhere except the tail corner (bottom, sender's side), which also tightens
        // the top corner inside a run.
        const corner = inbound ? `rounded-br-md ${first ? '' : 'rounded-tr-md'}` : `rounded-bl-md ${first ? '' : 'rounded-tl-md'}`;
        return (
          <div
            key={m.id ?? i}
            className={`bubble-in max-w-[85%] rounded-[20px] px-3.5 py-2 text-[15px] leading-[1.35] whitespace-pre-wrap [overflow-wrap:anywhere] ${first ? 'mt-2' : 'mt-0.5'} ${inbound ? 'self-end' : 'self-start'} ${corner} ${BUBBLE[kind]}`}
          >
            {emergency && (
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-red-600">
                <span aria-hidden className="size-1.5 rounded-full bg-red-500 motion-safe:animate-pulse" />
                Emergency instruction
              </div>
            )}
            {toCaregiver && <div className="mb-0.5 text-[10px] font-bold uppercase tracking-wider opacity-70">→ caregiver</div>}
            {m.to === 'nurse' && <div className="mb-0.5 text-[10px] font-bold uppercase tracking-wider opacity-70">→ nurse</div>}
            {inbound && m.from === 'caregiver' && <div className="mb-0.5 text-[10px] font-bold uppercase tracking-wider opacity-80">caregiver</div>}
            <span className={emergency ? 'font-semibold' : undefined}>{m.text}</span>
            {showEnglish && m.textEn && m.textEn !== m.text && (
              <div className={`mt-1.5 border-t pt-1.5 text-xs leading-snug ${inbound ? 'border-white/25 text-white/80' : emergency ? 'border-red-200 text-red-900/70' : 'border-black/5 text-slate-500'}`}>
                <span className={`mr-1.5 rounded px-1 py-px text-[9px] font-bold tracking-wider ${inbound ? 'bg-white/20' : 'bg-black/5'}`}>EN</span>
                {m.textEn}
              </div>
            )}
            {m.buttons?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {m.buttons.flat().map((b) => (
                  <button
                    key={b.data}
                    disabled={!tappable || i !== live || !onTap}
                    onClick={() => onTap?.(b.data)}
                    className="rounded-full bg-white px-3 py-1.5 text-[13px] font-medium text-blue-700 shadow-sm ring-1 ring-blue-200 transition enabled:hover:bg-blue-50 enabled:active:scale-95 disabled:opacity-40 disabled:shadow-none"
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

// Three dots while the bot is "typing" (the reply can take a few seconds with an AI).
export const TypingDots = () => (
  <div className="bubble-in mt-2 self-start rounded-[20px] rounded-bl-md bg-white px-3.5 py-3 shadow-sm ring-1 ring-black/5" aria-label="HeartBridge is typing" role="status">
    <span className="flex gap-1">
      {[0, 160, 320].map((d) => (
        <span key={d} className="typing-dot size-1.5 rounded-full bg-slate-400" style={{ animationDelay: `${d}ms` }} />
      ))}
    </span>
  </div>
);

// Bot messages often land in one burst (a scenario, or a reply plus the next question over the
// socket). Show them one at a time behind the typing dots instead of dumping the whole batch.
// History that was already there (first render, another patient, another role) shows at once.
export function useStaggered(list, key, { min = 350, max = 900, perChar = 6 } = {}) {
  const [state, setState] = useState({ key, count: list.length });
  if (state.key !== key) setState({ key, count: list.length });
  const count = state.key === key ? Math.min(state.count, list.length) : list.length;
  // Read the list through a ref: a re-fetch hands us a new array with the same messages, and
  // that must not restart the timer (polling faster than the delay would stall the reveal).
  const ref = useRef(list);
  ref.current = list;
  useEffect(() => {
    if (count >= ref.current.length) return;
    const next = ref.current[count];
    const delay = next.direction === 'in' ? 0 : Math.min(max, min + (next.text?.length ?? 0) * perChar);
    const id = setTimeout(() => setState((s) => ({ ...s, count: s.count + 1 })), delay);
    return () => clearTimeout(id);
  }, [count, list.length, min, max, perChar]);
  return { visible: list.slice(0, count), pending: count < list.length };
}

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
  const shown = useMemo(
    () => messages.filter((m) => (role === 'caregiver' ? m.to === 'caregiver' || m.from === 'caregiver' : m.to !== 'caregiver' && m.from !== 'caregiver' && m.to !== 'nurse')),
    [messages, role],
  );
  const { visible, pending } = useStaggered(shown, `${patient.id}:${role}`);
  const typing = busy || pending;

  // Scroll the chat box itself (scrollIntoView scrolled the whole page to the bottom).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (el.scrollTo) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight; // jsdom
  }, [visible.length, typing]);

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
    <div className={`mx-auto w-full rounded-[2.5rem] bg-slate-900 p-2 shadow-2xl shadow-slate-900/25 ring-1 ring-white/10 ${compact ? 'max-w-sm' : 'max-w-md'}`}>
      <div className={`flex flex-col overflow-hidden rounded-[2rem] bg-linear-to-b from-sky-50 to-slate-100 ${compact ? 'h-[min(34rem,70vh)]' : 'h-[min(40rem,75vh)]'}`}>
        <div className="flex items-center gap-2.5 border-b border-black/5 bg-white/85 px-4 pb-2.5 pt-3 backdrop-blur">
          <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-linear-to-br from-blue-500 to-indigo-600 text-sm shadow-sm ring-2 ring-white">
            💙
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="text-sm font-semibold text-slate-900">HeartBridge</div>
            <div className="text-[11px] text-emerald-600">{typing ? 'typing…' : 'online'}</div>
          </div>
          {onRoleChange && (
            <select aria-label="Chat as" value={role} onChange={(e) => onRoleChange(e.target.value)} className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-700 ring-1 ring-inset ring-slate-200">
              <option value="patient">as {patient.name.split(' ')[0]}</option>
              <option value="caregiver">as caregiver{patient.caregiver?.name ? ` (${patient.caregiver.name.split(' ')[0]})` : ''}</option>
            </select>
          )}
        </div>
        <div ref={box} className="no-scrollbar flex flex-1 flex-col overflow-y-auto overscroll-contain px-3 pb-3 pt-1" data-testid="chat-box" aria-live="polite">
          <ChatLog messages={visible} role={role} tappable={!typing} onTap={tap} />
          {typing && <TypingDots />}
        </div>
        {error && (
          <p role="alert" className="border-t border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-800">
            {error}
          </p>
        )}
        <form onSubmit={send} className="flex items-center gap-2 border-t border-black/5 bg-white/85 px-2.5 py-2 backdrop-blur">
          <input ref={file} type="file" accept="image/*" className="hidden" onChange={pickPhoto} aria-label="Photo" />
          {role === 'patient' && (
            <button type="button" onClick={() => file.current?.click()} disabled={busy} title="Send a photo (scale, pill bottle)" aria-label="Send a photo" className="grid size-9 shrink-0 place-items-center rounded-full text-slate-500 transition hover:bg-slate-100 disabled:opacity-40">
              <Camera size={18} aria-hidden />
            </button>
          )}
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={role === 'caregiver' ? 'Message as caregiver…' : 'Message as patient…'} className="min-w-0 flex-1 rounded-full bg-slate-100 px-4 py-2 text-sm text-slate-900 outline-none ring-1 ring-inset ring-transparent transition placeholder:text-slate-400 focus:bg-white focus:ring-blue-400" />
          <button type="submit" aria-label="Send" disabled={busy || !draft.trim()} className="grid size-9 shrink-0 place-items-center rounded-full bg-blue-600 text-white shadow-sm transition hover:bg-blue-700 active:scale-95 disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none">
            <SendHorizontal size={16} aria-hidden />
          </button>
        </form>
      </div>
    </div>
  );
}
