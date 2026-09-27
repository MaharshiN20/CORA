// One worklist item: tier + kind, reasons, live SLA countdown, and the nurse flow
// Acknowledge -> Mark contacted -> Resolve (with an outcome picker).
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api.js';
import { sla, nextAction, OUTCOMES, resolvePatch } from '../lib/worklist.js';
import { timeOf } from '../lib/format.js';
import { TierBadge, KindBadge, Button } from './ui.jsx';

const BORDER = { RED: 'border-l-red-500', YELLOW: 'border-l-amber-400', INFO: 'border-l-slate-300' };

export function SlaCountdown({ alert, now }) {
  const s = sla(alert, now);
  if (!s) return null;
  return (
    <span
      data-testid="sla"
      className={`rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums ${s.overdue ? 'animate-pulse bg-red-600 text-white' : s.remainingMs < 15 * 60000 ? 'bg-amber-100 text-amber-900' : 'bg-slate-100 text-slate-600'}`}
    >
      ⏱ {s.label}
    </span>
  );
}

export default function AlertCard({ alert, patient, now, update = api.updateAlert }) {
  const [resolving, setResolving] = useState(false);
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const next = nextAction(alert);

  const run = async (patch) => {
    setBusy(true);
    setError(null);
    try {
      await update(alert.id, patch);
      setResolving(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const advance = () => (next.status === 'resolved' ? setResolving(true) : run({ status: next.status, by: 'nurse' }));
  const resolve = () => {
    try {
      run(resolvePatch(outcome, note));
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <article className={`rounded-xl border border-l-4 border-slate-200 bg-white p-4 shadow-sm ${BORDER[alert.tier] ?? ''}`} aria-label={`${alert.tier} alert`}>
      <div className="flex flex-wrap items-center gap-2">
        <TierBadge tier={alert.tier} />
        <KindBadge alert={alert} />
        {patient ? (
          <Link to={`/patients/${patient.id}`} className="font-semibold text-slate-900 hover:underline">
            {patient.name}
          </Link>
        ) : (
          <span className="font-semibold">{alert.patientId}</span>
        )}
        {alert.source === 'ai_review' && <span className="rounded bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-800">AI review</span>}
        <span className="ml-auto flex items-center gap-2">
          <SlaCountdown alert={alert} now={now} />
          <span className="text-xs capitalize text-slate-500">{alert.status}</span>
        </span>
      </div>
      {alert.title && <p className="mt-2 font-medium text-slate-800">{alert.title}</p>}
      {alert.reasons?.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-slate-700">
          {alert.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      {alert.ai?.nurseSummary && <p className="mt-2 rounded-md bg-violet-50 p-2 text-sm text-violet-900">🤖 {alert.ai.nurseSummary}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span>Opened {timeOf(alert.ts)}</span>
        {alert.assignee && <span>· {alert.assignee}</span>}
        <span className="ml-auto flex gap-2">
          {next && !resolving && (
            <Button onClick={advance} disabled={busy}>
              {next.label}
            </Button>
          )}
          {alert.status !== 'contacted' && alert.status !== 'resolved' && !resolving && (
            <Button variant="subtle" onClick={() => setResolving(true)} disabled={busy}>
              Resolve…
            </Button>
          )}
        </span>
      </div>
      {resolving && (
        <div className="mt-3 space-y-2 rounded-lg bg-slate-50 p-3" role="group" aria-label="Resolve">
          <div className="flex flex-wrap gap-2">
            {OUTCOMES.map((o) => (
              <label key={o.value} className={`cursor-pointer rounded-full px-3 py-1 text-sm ring-1 ${outcome === o.value ? 'bg-blue-600 text-white ring-blue-600' : 'bg-white ring-slate-300'}`}>
                <input type="radio" name={`outcome-${alert.id}`} value={o.value} checked={outcome === o.value} onChange={() => setOutcome(o.value)} className="sr-only" />
                {o.label}
              </label>
            ))}
          </div>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm" />
          <div className="flex gap-2">
            <Button onClick={resolve} disabled={busy}>
              Resolve
            </Button>
            <Button variant="subtle" onClick={() => (setResolving(false), setError(null))}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </article>
  );
}
