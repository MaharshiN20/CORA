// Small shared UI pieces. Tier colors are the same everywhere: RED/High = red,
// YELLOW/Med = amber, GREEN/Low = green, INFO = slate.
import { useState } from 'react';
import { kindOf } from '../lib/worklist.js';

const TIER_STYLE = {
  RED: 'bg-red-100 text-red-800 ring-red-300',
  High: 'bg-red-100 text-red-800 ring-red-300',
  YELLOW: 'bg-amber-100 text-amber-900 ring-amber-300',
  Med: 'bg-amber-100 text-amber-900 ring-amber-300',
  GREEN: 'bg-emerald-100 text-emerald-800 ring-emerald-300',
  Low: 'bg-emerald-100 text-emerald-800 ring-emerald-300',
  INFO: 'bg-slate-100 text-slate-700 ring-slate-300',
};

export function TierBadge({ tier, suffix = '', className = '' }) {
  if (!tier) return null;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ring-1 ring-inset ${TIER_STYLE[tier] ?? TIER_STYLE.INFO} ${className}`}>
      {tier}
      {suffix}
    </span>
  );
}

export function KindBadge({ alert }) {
  const k = kindOf(alert);
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
      <span aria-hidden>{k.icon}</span>
      {k.label}
    </span>
  );
}

export const Card = ({ title, action, children, className = '' }) => (
  <section className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm ${className}`}>
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
  <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
    <div className={`mt-1 text-3xl font-bold tabular-nums ${TONE[tone] ?? TONE.slate}`}>{value}</div>
    {sub && <div className="mt-1 text-sm text-slate-500">{sub}</div>}
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
    primary: 'bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300',
    ghost: 'bg-white text-blue-700 ring-1 ring-inset ring-blue-200 hover:bg-blue-50',
    danger: 'bg-red-600 text-white hover:bg-red-700',
    subtle: 'bg-slate-100 text-slate-700 hover:bg-slate-200',
  };
  return <button className={`rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed ${styles[variant]} ${className}`} {...props} />;
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
