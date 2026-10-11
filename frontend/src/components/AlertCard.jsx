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

// A RED card must be unmistakable from across the room (projector), and nothing else may look
// like one: only RED gets a tinted surface and a glow. Every tier gets a thin coloured spine
// (the <span> at the card's left edge) instead of a heavy border + ring + full tint.
const CARD = {
  RED: 'bg-linear-to-br from-red-50 via-white to-white ring-red-200 shadow-lg shadow-red-900/10',
  YELLOW: 'bg-white ring-slate-200 shadow-sm',
  INFO: 'bg-white ring-slate-200 shadow-sm',
};
const SPINE = {
  RED: 'bg-linear-to-b from-red-500 to-red-700',
  YELLOW: 'bg-linear-to-b from-amber-300 to-amber-500',
  INFO: 'bg-linear-to-b from-slate-200 to-slate-400',
};

// The SLA pill speaks the alert's tier: a RED is red however much time is left.
function slaTone(tier, s) {
  if (tier === 'RED') return s.overdue ? 'motion-safe:animate-pulse bg-red-600 text-white ring-red-300' : 'bg-red-600 text-white ring-red-700/40 shadow-sm shadow-red-600/30';
  if (s.overdue) return 'motion-safe:animate-pulse bg-red-600 text-white ring-red-700/40';
  if (tier === 'YELLOW') return s.remainingMs < 60 * 60000 ? 'bg-amber-400 text-amber-950 ring-amber-500/50' : 'bg-amber-50 text-amber-900 ring-amber-300';
  return 'bg-white text-slate-600 ring-slate-300';
}

// How much of the SLA window is left (1 = just opened, 0 = due). The window is opened -> dueBy,
// so it follows whatever SLA the backend set per tier instead of hardcoding 15 min / 4 h / 24 h.
function slaFraction(alert, s) {
  const total = Date.parse(alert.dueBy) - Date.parse(alert.ts);
  if (!Number.isFinite(total) || total <= 0) return s.overdue ? 0 : 1;
  return Math.max(0, Math.min(1, s.remainingMs / total));
}

// Ticks by itself (on the demo clock), so the page doesn't re-render every card each second.
// `now` is only for tests / callers that want to pin the time.
export function SlaCountdown({ alert, now }) {
  const own = useNow(now == null ? 1000 : 3_600_000, useHealth()?.demoOffsetMs ?? 0);
  const s = sla(alert, now ?? own);
  if (!s) return null;
  const R = 5;
  const C = 2 * Math.PI * R;
  return (
    <span data-testid="sla" className={`inline-flex items-center gap-1.5 rounded-full py-0.5 pl-1 pr-2.5 text-xs font-semibold tabular-nums ring-1 ring-inset ${slaTone(alert.tier, s)}`}>
      {/* Draining ring: how much of the window is left, readable at a glance without the number. */}
      <svg viewBox="0 0 14 14" className="size-3.5 -rotate-90" aria-hidden>
        <circle cx="7" cy="7" r={R} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <circle cx="7" cy="7" r={R} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - slaFraction(alert, s))} />
      </svg>
      {s.label}
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

// Same thresholds the rules use to flag fluid (2 lb/24h, 5 lb over dry), so colour = "a rule cares".
const toneDry = (d) => (d == null ? 'none' : d >= 5 ? 'red' : d >= 2 ? 'amber' : 'ok');
const tone24 = (d) => (d == null ? 'none' : d >= 2 ? 'red' : d >= 1 ? 'amber' : 'ok');
const toneSpo2 = (v) => (v == null ? 'none' : v < 90 ? 'red' : v < 93 ? 'amber' : 'ok');
const TEXT = { ok: 'text-emerald-700', amber: 'text-amber-700', red: 'text-red-600', none: 'text-slate-400' };
const FILL = { ok: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500', none: 'bg-slate-300' };
const DRY_GAUGE_MAX = 7; // lb over dry weight at which the gauge is full

function Cell({ label, children, foot, size }) {
  return (
    <div className={`min-w-0 ${size === 'lg' ? 'px-4 py-3' : 'px-3 py-2'}`}>
      <dt className="truncate text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">{label}</dt>
      <dd className="mt-0.5 flex items-baseline gap-1 tabular-nums">{children}</dd>
      {foot && <div className="mt-1 text-[11px] leading-tight text-slate-500">{foot}</div>}
    </div>
  );
}

// Latest pulse-ox from a check-in (device or typed), if the patient ever gave one.
const latestSpo2 = (patient) => (patient?.checkins ?? []).findLast((c) => c.answers?.spo2 != null);

// What the nurse needs to act without clicking through: today's weight and its 24h change,
// how far over dry weight (gauge with the 2 / 5 lb lines), SpO₂ when we have one, and how to
// reach the patient. size="lg" is the patient-page header version.
export function VitalsStrip({ patient, tier, size = 'sm' }) {
  const weights = patient?.weights ?? [];
  if (!weights.length) return null;
  const last = weights.at(-1).lb;
  const dry = patient.dryWeightLb;
  const overDry = dry != null ? last - dry : null;
  const week = weights.slice(-7).map((w) => w.lb);
  const values = week.concat(dry ? [dry] : []);
  const stroke = tier === 'RED' ? '#dc2626' : tier === 'YELLOW' ? '#d97706' : '#2563eb';
  const d24 = patient.signals?.weightDelta24h;
  const ox = latestSpo2(patient);
  const big = size === 'lg' ? 'text-2xl' : 'text-lg';
  const cols = ox ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3';
  return (
    <div data-testid="vitals" className={`${size === 'lg' ? '' : 'mt-3'} overflow-hidden rounded-xl bg-linear-to-b from-slate-50 to-slate-100/60 ring-1 ring-inset ring-slate-200/90`}>
      <dl className={`grid ${cols} divide-x divide-slate-200/80`}>
        <Cell
          label="Weight"
          size={size}
          foot={
            <span className="flex items-center justify-between gap-2">
              <span className={`whitespace-nowrap font-semibold ${TEXT[tone24(d24)]}`}>{signed(d24)} /24h</span>
              {week.length > 1 && <Sparkline values={values} points={week} dry={dry} stroke={stroke} />}
            </span>
          }
        >
          <span className={`${big} whitespace-nowrap font-semibold tracking-tight text-slate-900`}>{last} lb</span>
        </Cell>
        <Cell
          label={dry != null ? `Dry weight ${dry} lb` : 'Dry weight'}
          size={size}
          foot={
            overDry != null && (
              <div className="relative mt-1.5 h-1.5 rounded-full bg-slate-200" aria-hidden>
                <div className={`h-full rounded-full ${FILL[toneDry(overDry)]}`} style={{ width: `${Math.max(0, Math.min(1, overDry / DRY_GAUGE_MAX)) * 100}%` }} />
                {[2, 5].map((t) => (
                  <span key={t} className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-slate-400/80" style={{ left: `${(t / DRY_GAUGE_MAX) * 100}%` }} />
                ))}
              </div>
            )
          }
        >
          <span className={`${big} font-semibold tracking-tight ${TEXT[toneDry(overDry)]}`}>{signed(overDry)}</span>
          <span className="whitespace-nowrap text-xs text-slate-500"> vs dry</span>
        </Cell>
        {ox && (
          <Cell label="SpO₂" size={size} foot={`at ${timeOf(ox.ts)}`}>
            <span className={`${big} font-semibold tracking-tight ${TEXT[toneSpo2(ox.answers.spo2)]}`}>{ox.answers.spo2}</span>
            <span className="text-xs text-slate-500">%</span>
          </Cell>
        )}
        <Cell label="Reach" size={size} foot={patient.language && languageName(patient.language)}>
          {patient.contactPhone ? (
            <a href={`tel:${patient.contactPhone.replace(/[^\d+]/g, '')}`} className="inline-flex min-w-0 items-center gap-1 truncate text-sm font-semibold text-blue-700 hover:underline">
              <Phone size={13} aria-hidden /> {patient.contactPhone}
            </a>
          ) : (
            <span className="text-sm text-slate-400">no phone</span>
          )}
        </Cell>
      </dl>
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
    <article id={`alert-${alert.id}`} className={`relative overflow-hidden rounded-2xl py-4 pl-6 pr-4 ring-1 transition-shadow hover:shadow-md ${CARD[alert.tier] ?? CARD.INFO} ${highlight ? '!ring-4 !ring-blue-400' : ''}`} aria-label={`${alert.tier} alert for ${patient?.name ?? alert.patientId}`}>
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1.5 ${SPINE[alert.tier] ?? SPINE.INFO}`} />
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
          <Link to={`/patients/${patient.id}`} className="text-[15px] font-semibold tracking-tight text-slate-900 underline-offset-2 hover:underline projector:text-lg">
            {patient.name}
          </Link>
        ) : (
          <span className="font-semibold">{alert.patientId}</span>
        )}
        {alert.source === 'ai_review' && <span className="rounded bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-800">AI review</span>}
        <span className="ml-auto flex items-center gap-2">
          <SlaCountdown alert={alert} now={now} />
          {alert.status !== 'open' && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium capitalize text-emerald-700 ring-1 ring-inset ring-emerald-200">{alert.status}</span>}
        </span>
      </div>
      {alert.title && <p className={`mt-2 text-[15px] font-semibold leading-snug tracking-tight projector:text-xl ${alert.tier === 'INFO' ? 'text-slate-700' : 'text-slate-900'}`}>{alert.title}</p>}
      {alert.reasons?.length > 0 && (
        <ul className="mt-2 space-y-1 text-[13px] leading-snug text-slate-600 projector:text-base">
          {alert.reasons.map((r, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-slate-400" />
              {r}
            </li>
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
  const W = 64;
  const H = 18;
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
