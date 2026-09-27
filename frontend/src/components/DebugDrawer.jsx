// "How it decided": the judge's view of the LLM / rules split for the latest message.
// Three panes from the parse_trace audit entry the backend writes for every check-in input:
//   raw message -> what the AI extracted (with the evidence it quoted, and what the validator
//   dropped) -> which deterministic rules fired and the tier.
// Toggle with the D key (ignored while typing) or the floating button.
import { useEffect, useState } from 'react';
import { Bug, X } from 'lucide-react';
import { TierBadge } from './ui.jsx';

export const latestTrace = (audit = []) => [...audit].reverse().find((e) => e.type === 'parse_trace') ?? null;

const typing = (el) => el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

export function useDebugToggle() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key.toLowerCase() !== 'd' || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      setOpen((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return [open, setOpen];
}

const Json = ({ value }) => <pre className="mt-1 max-h-44 overflow-auto rounded bg-slate-950 p-2 text-[11px] leading-snug text-emerald-200">{JSON.stringify(value, null, 2)}</pre>;

function Pane({ n, title, children }) {
  return (
    <div className="min-w-0 rounded-lg bg-slate-800 p-3">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {n} · {title}
      </div>
      {children}
    </div>
  );
}

export function TracePanes({ trace }) {
  if (!trace) return <p className="text-sm text-slate-400">No check-in messages yet. Answer a question in the simulator and this fills in.</p>;
  const d = trace.data ?? {};
  const llm = d.llm;
  const outcome = d.outcome;
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <Pane n="1" title="Raw message">
        <p className="text-sm text-white">{d.text ? `“${d.text}”` : <span className="font-mono">button {d.button}</span>}</p>
        <p className="mt-1 text-xs text-slate-400">
          question: <b className="text-slate-200">{d.step}</b>
          {d.reporter === 'caregiver' && ' · from the caregiver'}
        </p>
      </Pane>
      <Pane n="2" title="AI extraction (evidence-checked)">
        {!llm ? (
          <p className="text-sm text-slate-300">Not called: {d.button ? 'a button tap needs no AI.' : 'the rules understood it (or AI is off).'}</p>
        ) : llm.timedOut ? (
          <p className="text-sm text-amber-300">Timed out after {llm.ms} ms: rules + buttons took over.</p>
        ) : (
          <>
            {llm.fields ? <Json value={llm.fields} /> : <p className="text-sm text-slate-300">Nothing extracted.</p>}
            {llm.dropped?.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-xs text-red-300">
                {llm.dropped.map((x, i) => (
                  <li key={i}>
                    ✗ dropped {x.field}={JSON.stringify(x.value)}: {x.reason}
                  </li>
                ))}
              </ul>
            )}
            {llm.unverified?.length > 0 && <p className="mt-1 text-xs text-amber-300">kept but unverified (emergency, lean to 911): {llm.unverified.join(', ')}</p>}
            <p className="mt-1 text-[11px] text-slate-500">{llm.ms} ms</p>
          </>
        )}
      </Pane>
      <Pane n="3" title="Deterministic rules">
        <p className="text-xs text-slate-400">read by the rules this message:</p>
        {Object.keys(d.rules ?? {}).length ? <Json value={d.rules} /> : <p className="text-sm text-slate-300">nothing</p>}
        {outcome ? (
          <div className="mt-2">
            <TierBadge tier={outcome.tier} />
            <ul className="mt-1 space-y-0.5 text-xs text-slate-200">
              {outcome.flags.length ? outcome.flags.map((f) => <li key={f.code}>• {f.code}: {f.text}</li>) : <li>• no rule fired</li>}
            </ul>
          </div>
        ) : (
          <p className="mt-2 text-xs text-slate-400">Check-in continues: tier is decided on the last answer.</p>
        )}
      </Pane>
    </div>
  );
}

export default function DebugDrawer({ audit, patientName }) {
  const [open, setOpen] = useDebugToggle();
  const trace = latestTrace(audit);
  return (
    <>
      {!open && (
        <button onClick={() => setOpen(true)} className="fixed bottom-4 left-4 z-30 inline-flex items-center gap-1.5 rounded-full bg-slate-900 px-3 py-1.5 text-xs font-medium text-white shadow-lg hover:bg-slate-800 projector:hidden" title="Show how the last message was understood (D)">
          <Bug size={13} aria-hidden /> How it decided <kbd className="rounded bg-slate-700 px-1">D</kbd>
        </button>
      )}
      {open && (
        <div className="fixed inset-x-0 bottom-0 z-30 max-h-[60vh] overflow-y-auto border-t border-slate-700 bg-slate-900 p-4 shadow-2xl" role="dialog" aria-label="How it decided">
          <div className="mx-auto max-w-[1400px]">
            <div className="mb-3 flex items-center gap-2 text-white">
              <Bug size={16} aria-hidden />
              <b>How it decided{patientName ? `: ${patientName}'s last message` : ''}</b>
              <span className="text-sm text-slate-400">The AI only extracts, with quoted evidence. Rules decide the tier.</span>
              <button onClick={() => setOpen(false)} aria-label="Close" className="ml-auto text-slate-400 hover:text-white">
                <X size={18} />
              </button>
            </div>
            <TracePanes trace={trace} />
          </div>
        </div>
      )}
    </>
  );
}
