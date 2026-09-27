// One-click standing order (HF-02) on a YELLOW fluid-gain alert. The card shows WHOSE protocol
// it is and every eligibility check the server ran; the nurse clicks, gets 5 seconds to undo,
// then the server re-checks and applies it (message to the patient in their language,
// alert -> contacted, re-weigh task for 08:00 tomorrow, FHIR previews).
import { useEffect, useRef, useState } from 'react';
import { CircleCheck, CircleX, CircleHelp, Pill, Undo2 } from 'lucide-react';
import { api } from '../api.js';
import { timeOf } from '../lib/format.js';
import { Button } from './ui.jsx';

export const UNDO_MS = 5000;

const CHECK_ICON = {
  pass: <CircleCheck size={16} className="shrink-0 text-emerald-600" aria-label="pass" />,
  fail: <CircleX size={16} className="shrink-0 text-red-600" aria-label="fail" />,
  unknown: <CircleHelp size={16} className="shrink-0 text-slate-400" aria-label="unknown" />,
};

export default function ProtocolCard({ alert, apply = api.applyProtocol, askBp = (id) => api.template(id, 'ask_bp'), escalate = (id) => api.updateAlert(id, { assignee: 'Cardiology', note: 'Escalated to cardiologist instead of standing order', by: 'nurse' }), undoMs = UNDO_MS }) {
  const check = alert.protocolCheck;
  const [pending, setPending] = useState(null); // ms left in the undo window
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearInterval(timer.current), []);
  if (!check?.triggered) return null;
  const { protocol, checks, eligible } = check;
  const applied = result?.alert?.protocol ?? check.applied ?? alert.protocol;

  const start = () => {
    setError(null);
    const endsAt = Date.now() + undoMs;
    setPending(undoMs);
    timer.current = setInterval(async () => {
      const left = endsAt - Date.now();
      if (left > 0) return setPending(left);
      clearInterval(timer.current);
      setPending(null);
      try {
        setResult(await apply(alert.id));
      } catch (e) {
        setError(e.body?.error ?? e.message);
      }
    }, 100);
  };
  const undo = () => {
    clearInterval(timer.current);
    setPending(null);
  };
  const act = async (fn, done) => {
    setError(null);
    try {
      await fn();
      setNote(done);
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <section className="mt-3 rounded-lg border border-blue-200 bg-blue-50/60 p-3 text-sm" aria-label="Standing order">
      <div className="flex flex-wrap items-center gap-2">
        <Pill size={16} className="text-blue-700" aria-hidden />
        <b className="text-blue-950">
          Standing order {protocol.id}: {protocol.title.replace(/^Standing order:\s*/i, '')}
        </b>
        {protocol.demo && <span className="rounded bg-amber-200 px-1.5 text-[11px] font-bold uppercase text-amber-900">Demo protocol</span>}
        <span className="ml-auto text-xs text-slate-500">
          {protocol.authoredBy} · v{protocol.version}
        </span>
      </div>
      <ul className="mt-2 space-y-1">
        {checks.map((c) => (
          <li key={c.id} className="flex items-start gap-2">
            {CHECK_ICON[c.status]}
            <span>
              <span className="font-medium">{c.label}</span>
              {!c.required && c.status !== 'pass' && <span className="text-slate-500"> (optional)</span>}
              <span className="text-slate-600">: {c.detail}</span>
              {c.action === 'ask_bp' && c.status === 'unknown' && !applied && (
                <button className="ml-2 text-xs font-medium text-blue-700 underline" onClick={() => act(() => askBp(alert.patientId), 'Asked the patient for a blood pressure reading.')}>
                  Ask patient for BP
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>

      {applied ? (
        <div className="mt-3 rounded-md bg-emerald-50 p-2 text-emerald-900" role="status">
          ✅ Applied by {applied.by} {applied.appliedAt ? `at ${timeOf(applied.appliedAt)}` : ''}: patient notified, re-weigh task scheduled for 08:00 tomorrow.
          {result?.fhir && (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs font-medium">FHIR MedicationRequest + CommunicationRequest (preview)</summary>
              <pre className="mt-1 max-h-56 overflow-auto rounded bg-slate-900 p-2 text-[11px] leading-snug text-emerald-100">{JSON.stringify(result.fhir, null, 2)}</pre>
            </details>
          )}
          {result?.message?.textEn && <p className="mt-1 text-xs text-emerald-800">Sent: “{result.message.textEn}”</p>}
        </div>
      ) : pending != null ? (
        <div className="mt-3 flex items-center gap-3 rounded-md bg-slate-900 px-3 py-2 text-white" role="status">
          Applying {protocol.id} in {Math.ceil(pending / 1000)}s…
          <button onClick={undo} className="ml-auto inline-flex items-center gap-1 rounded bg-white px-2 py-0.5 text-xs font-semibold text-slate-900">
            <Undo2 size={12} aria-hidden /> Undo
          </button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={start} disabled={!eligible} className="bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300" title={eligible ? '' : 'Not eligible: see the checks above'}>
            ✍️ Apply protocol & notify patient
          </Button>
          <Button variant="ghost" onClick={() => act(() => escalate(alert.id), 'Escalated to cardiology.')}>
            Escalate to cardiologist
          </Button>
          {!eligible && <span className="text-xs text-slate-600">Not eligible until every required check passes.</span>}
        </div>
      )}
      {note && <p className="mt-2 text-xs text-slate-700">{note}</p>}
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
      <p className="mt-2 text-[11px] leading-snug text-slate-500">{protocol.disclaimer} The dose comes from the clinic's protocol file, never from AI.</p>
    </section>
  );
}
