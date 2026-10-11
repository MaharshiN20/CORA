// One worklist item: tier + kind, reasons, live SLA countdown, and the nurse flow
// Acknowledge -> Mark contacted -> Resolve (with an outcome picker).
import { memo, useState } from 'react';
import { Link } from 'react-router';
import { Phone } from 'lucide-react';
import { api } from '../api.js';
import { useNow } from '../hooks.js';
import { useHealth } from '../App.jsx';
import { sla, nextAction, OUTCOMES, resolvePatch, aiOf, bulkable } from '../lib/worklist.js';
import { readNurse, nurseBy } from '../lib/nurse.js';
import { timeOf, languageName } from '../lib/format.js';
import { TierBadge, KindBadge, Button } from './ui.jsx';
import ProtocolCard from './ProtocolCard.jsx';

// A RED card must be unmistakable from across the room (projector): tinted, ringed, thick edge.
const CARD = {
  RED: 'border-red-300 border-l-red-600 bg-red-50/70 ring-2 ring-red-500/40',
  YELLOW: 'border-slate-200 border-l-amber-400 bg-white',
  INFO: 'border-slate-200 border-l-slate-300 bg-white',
};

// The SLA pill speaks the alert's tier: a RED is red however much time is left.
function slaTone(tier, s) {
  if (tier === 'RED') return s.overdue ? 'animate-pulse bg-red-600 text-white ring-2 ring-red-300' : 'bg-red-600 text-white';
  if (s.overdue) return 'animate-pulse bg-red-600 text-white';
  if (tier === 'YELLOW') return s.remainingMs < 60 * 60000 ? 'bg-amber-400 text-amber-950' : 'bg-amber-100 text-amber-900';
  return 'bg-slate-100 text-slate-600';
}

// Ticks by itself (on the demo clock), so the page doesn't re-render every card each second.
// `now` is only for tests / callers that want to pin the time.
export function SlaCountdown({ alert, now }) {
  const own = useNow(now == null ? 1000 : 3_600_000, useHealth()?.demoOffsetMs ?? 0);
  const s = sla(alert, now ?? own);
  if (!s) return null;
  return (
    <span data-testid="sla" className={`rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums ${slaTone(alert.tier, s)}`}>
      ⏱ {s.label}
    </span>
  );
}

// The AI reviewer's summary, suggested next steps and its read on readmission risk.
export function AiBrief({ alert }) {
  const ai = aiOf(alert);
  if (!ai) return null;
  return (
    <div className="mt-2 rounded-md bg-violet-50 p-2 text-sm text-violet-900">
      {ai.nurseSummary && <p>🤖 {ai.nurseSummary}</p>}
      {ai.suggestedActions.length > 0 && (
        <ul aria-label="Suggested actions" className="mt-1 list-disc pl-5">
          {ai.suggestedActions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      )}
      {ai.readmissionRisk && <p className="mt-1 text-xs text-violet-700">Readmission risk: {ai.readmissionRisk}</p>}
    </div>
  );
}

const signed = (n) => (n == null ? '—' : `${n > 0 ? '▲' : n < 0 ? '▼' : ''}${Math.abs(Math.round(n * 10) / 10)}`);

// What the nurse needs to act without clicking through: today's weight and its trend, the
// last week as a sparkline against dry weight, and how to reach the patient.
export function VitalsStrip({ patient, tier }) {
  const weights = patient?.weights ?? [];
  if (!weights.length) return null;
  const last = weights.at(-1).lb;
  const dry = patient.dryWeightLb;
  const week = weights.slice(-7).map((w) => ({ lb: w.lb }));
  const values = week.map((w) => w.lb).concat(dry ? [dry] : []);
  const stroke = tier === 'RED' ? '#dc2626' : tier === 'YELLOW' ? '#d97706' : '#2563eb';
  const d24 = patient.signals?.weightDelta24h;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-slate-50 px-3 py-1.5 text-xs text-slate-700 tabular-nums" data-testid="vitals">
      <span>
        <b className="text-sm text-slate-900">{last} lb</b> <span className={d24 >= 2 ? 'font-semibold text-red-700' : ''}>{signed(d24)} /24h</span>
        {dry != null && <span className={last - dry >= 5 ? ' font-semibold text-red-700' : ''}> · {signed(last - dry)} vs dry</span>}
      </span>
      {week.length > 1 && (
        <Sparkline values={values} points={week.map((w) => w.lb)} dry={dry} stroke={stroke} />
      )}
      {patient.contactPhone && (
        <a href={`tel:${patient.contactPhone.replace(/[^\d+]/g, '')}`} className="inline-flex items-center gap-1 font-medium text-blue-700 hover:underline">
          <Phone size={12} aria-hidden /> {patient.contactPhone}
        </a>
      )}
      {patient.language && <span className="text-slate-500">{languageName(patient.language)}</span>}
    </div>
  );
}

// onSelect(id, checked) turns on the bulk-action checkbox. RED cards never get one.
function AlertCard({ alert, patient, now, update = api.updateAlert, highlight = false, selected = false, onSelect }) {
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

  // The signed-in nurse (NurseName in the header) is recorded on every step, and takes the alert
  // when they acknowledge it, so "mine" in the worklist means something.
  const advance = () => {
    if (next.status === 'resolved') return setResolving(true);
    const me = readNurse();
    return run({ status: next.status, by: nurseBy(), ...(me && !alert.assignee && next.status === 'acknowledged' && { assignee: me }) });
  };
  const resolve = () => {
    try {
      run(resolvePatch(outcome, note, nurseBy()));
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <article id={`alert-${alert.id}`} className={`rounded-xl border border-l-[6px] p-4 shadow-sm transition-shadow ${CARD[alert.tier] ?? CARD.INFO} ${highlight ? 'ring-4 ring-blue-400' : ''}`} aria-label={`${alert.tier} alert for ${patient?.name ?? alert.patientId}`}>
      <p id={`alert-${alert.id}-about`} className="sr-only">
        {patient?.name ?? alert.patientId}: {alert.title ?? alert.kind}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {onSelect && bulkable(alert) && (
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onSelect(alert.id, e.target.checked)}
            aria-label={`Select the ${alert.tier} alert for ${patient?.name ?? alert.patientId}`}
            className="h-4 w-4 cursor-pointer accent-blue-600 projector:hidden"
          />
        )}
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
      {alert.title && <p className={`mt-2 font-semibold projector:text-lg ${alert.tier === 'RED' ? 'text-red-900' : 'text-slate-800'}`}>{alert.title}</p>}
      {alert.reasons?.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-slate-700">
          {alert.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      <AiBrief alert={alert} />
      {alert.undelivered && (
        <p role="status" className="mt-2 rounded-md bg-amber-100 p-2 text-sm font-medium text-amber-900">
          ⚠ The nurse-group page for this alert could not be delivered. Retrying automatically; check the dashboard directly.
        </p>
      )}
      {(alert.kind ?? 'triage') === 'triage' && <VitalsStrip patient={patient} tier={alert.tier} />}
      {alert.protocolCheck?.triggered && alert.status !== 'resolved' && <ProtocolCard alert={alert} />}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span>Opened {timeOf(alert.ts)}</span>
        {alert.assignee && <span>· {alert.assignee}</span>}
        <span className="ml-auto flex gap-2">
          {next && !resolving && (
            <Button onClick={advance} disabled={busy} aria-describedby={`alert-${alert.id}-about`}>
              {next.label}
            </Button>
          )}
          {alert.status !== 'contacted' && alert.status !== 'resolved' && !resolving && (
            <Button variant="subtle" onClick={() => setResolving(true)} disabled={busy} aria-describedby={`alert-${alert.id}-about`}>
              Resolve…
            </Button>
          )}
        </span>
      </div>
      {resolving && (
        <div className="mt-3 space-y-2 rounded-lg bg-slate-50 p-3" role="group" aria-label="Resolve">
          <div className="flex flex-wrap gap-2">
            {OUTCOMES.map((o) => (
              <label key={o.value} className={`cursor-pointer rounded-full px-3 py-1 text-sm ring-1 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-blue-600 ${outcome === o.value ? 'bg-blue-600 text-white ring-blue-600' : 'bg-white ring-slate-300'}`}>
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

// Memoised: with stable alert objects (lib/worklist.js stabilize) a socket event re-renders only the
// cards that actually changed.
export default memo(AlertCard);

// A 7-day weight line as plain SVG: the worklist is the landing page, and charting it with recharts
// put the whole charting library in the main bundle (one 815 kB chunk before; audit 2026-10-11).
function Sparkline({ values, points, dry, stroke }) {
  const W = 90;
  const H = 28;
  const pad = 2;
  const lo = Math.min(...values) - 0.5;
  const hi = Math.max(...values) + 0.5;
  const x = (i) => pad + (i * (W - 2 * pad)) / (points.length - 1);
  const y = (v) => pad + ((hi - v) * (H - 2 * pad)) / (hi - lo);
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="7-day weight">
      {dry != null && <line x1={pad} x2={W - pad} y1={y(dry)} y2={y(dry)} stroke="#10b981" strokeDasharray="3 3" />}
      <polyline fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" points={points.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
    </svg>
  );
}
