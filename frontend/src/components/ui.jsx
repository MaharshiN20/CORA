// Small shared UI pieces. Two visual languages, never mixed:
//   triage tiers (RED / YELLOW / GREEN: "act now") are SOLID badges;
//   background risk (High / Med / Low: "who to watch") is an OUTLINE chip that says "risk",
// so five "High risk" patients don't drown out the one RED that needs a call.
import { useState } from 'react';
import { kindOf } from '../lib/worklist.js';

// GREEN is the normal state, so it is the quietest tier: a tinted chip, not a solid one. Only RED
// gets a solid fill + glow, so on a full worklist the eye lands on RED first.
const TIER_STYLE = {
  RED: 'bg-red-600 text-white ring-red-700 shadow-sm shadow-red-600/30',
  YELLOW: 'bg-amber-400 text-amber-950 ring-amber-500',
  GREEN: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  INFO: 'bg-slate-100 text-slate-700 ring-slate-300',
};
// Risk is neutral slate everywhere: if "High risk" were red too, it would read as a second RED.
// The level is carried by the 3-bar glyph and the word, not by colour.
const RISK_BARS = { High: 3, Med: 2, Low: 1 };

export function TierBadge({ tier, suffix = '', className = '' }) {
  if (!tier) return null;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold tracking-wide ring-1 ring-inset ${TIER_STYLE[tier] ?? TIER_STYLE.INFO} ${className}`}>
      {tier}
      {suffix}
    </span>
  );
}

// Background risk: "High risk ↑". Outline only, see the note at the top.
export function RiskBadge({ tier, trend, detail = '', className = '' }) {
  if (!tier) return null;
  const bars = RISK_BARS[tier] ?? 1;
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-300 ${className}`}>
      <span aria-hidden className="flex h-2.5 items-end gap-[2px]">
        {[1, 2, 3].map((i) => (
          <span key={i} className={`w-[3px] rounded-[1px] ${i <= bars ? 'bg-slate-700' : 'bg-slate-300'}`} style={{ height: `${i * 33}%` }} />
        ))}
      </span>
      <span>
        {tier} risk{trend && trend !== 'flat' ? ` ${TREND_ICON[trend] ?? ''}` : ''}
        {detail}
      </span>
    </span>
  );
}

export function KindBadge({ alert }) {
  const k = kindOf(alert);
  const Icon = k.Icon;
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
      {Icon ? <Icon size={13} aria-hidden strokeWidth={2.25} /> : <span aria-hidden>{k.icon}</span>}
      {k.label}
    </span>
  );
}

export const Card = ({ title, action, children, className = '' }) => (
  <section className={`rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/80 ${className}`}>
    {(title || action) && (
      <div className="mb-3 flex items-center justify-between gap-2">
        {title && <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>}
        {action}
      </div>
    )}
    {children}
  </section>
);

const TONE = { slate: 'text-slate-800', red: 'text-red-700', green: 'text-emerald-700', blue: 'text-blue-700', amber: 'text-amber-700', violet: 'text-violet-700' };

export const Stat = ({ label, value, sub, tone = 'slate' }) => (
  <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/80">
    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
    <div className={`mt-1 text-3xl font-bold tabular-nums ${TONE[tone] ?? TONE.slate}`}>{value}</div>
    {sub && <div className="mt-1 text-sm text-slate-500">{sub}</div>}
  </div>
);

// A load failed. `stale` = we are still showing older data underneath.
export const ErrorNotice = ({ what, error, onRetry, stale = false }) => (
  <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
    <span>
      {stale ? `Couldn't refresh ${what}; showing the last data we have.` : `Couldn't load ${what}.`}
      {error?.message && <span className="ml-1 text-red-700">({error.message})</span>}
    </span>
    {onRetry && (
      <button onClick={onRetry} className="ml-auto rounded-md bg-red-600 px-3 py-1 font-medium text-white hover:bg-red-700">
        Retry
      </button>
    )}
  </div>
);

export const Empty = ({ children }) => <p className="py-6 text-center text-sm text-slate-400">{children}</p>;

export const Pill = ({ ok, label }) => (
  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${ok ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500'}`}>
    <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle ${ok ? 'bg-emerald-500' : 'bg-slate-400'}`} />
    {label}
  </span>
);

export function Button({ variant = 'primary', className = '', ...props }) {
  const styles = {
    primary: 'bg-blue-600 text-white shadow-sm shadow-blue-900/10 ring-1 ring-inset ring-white/10 hover:bg-blue-700 disabled:bg-blue-300 disabled:shadow-none',
    ghost: 'bg-white text-blue-700 ring-1 ring-inset ring-blue-200 hover:bg-blue-50 hover:ring-blue-300',
    danger: 'bg-red-600 text-white shadow-sm shadow-red-900/20 hover:bg-red-700',
    subtle: 'bg-slate-100 text-slate-700 hover:bg-slate-200',
    // Destructive but not urgent (e.g. Reset demo): red only on hover, so it never competes with a RED alert.
    quiet: 'bg-white text-slate-600 ring-1 ring-inset ring-slate-300 hover:bg-red-50 hover:text-red-700 hover:ring-red-300',
  };
  return <button className={`rounded-lg px-3 py-1.5 text-sm font-medium transition active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:active:scale-100 ${styles[variant]} ${className}`} {...props} />;
}

// A button for a request: disabled while it runs, and a failure is shown next to it instead
// of becoming an unhandled promise rejection.
export function AsyncButton({ onClick, children, disabled, ...props }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onClick();
    } catch (e) {
      setError(e.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-col items-end">
      <Button {...props} disabled={busy || disabled} onClick={run}>
        {children}
      </Button>
      {error && (
        <span role="alert" className="mt-1 max-w-56 text-right text-xs text-red-700">
          {error}
        </span>
      )}
    </span>
  );
}

export const TREND_ICON = { up: '↑', down: '↓', flat: '→' };
