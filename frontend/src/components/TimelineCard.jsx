// A patient's whole story on one axis (GET /patients/:id/timeline), with a risk trajectory chart
// (GET /patients/:id/risk-history). Filter by kind; newest first.
import { useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { timeOf } from '../lib/format.js';
import { Card, Empty, ErrorNotice, TierBadge } from './ui.jsx';

export const KIND_META = {
  checkin: { icon: '✅', label: 'Check-ins' },
  message: { icon: '💬', label: 'Messages' },
  alert: { icon: '🚨', label: 'Alerts' },
  reading: { icon: '📟', label: 'Readings' },
  risk: { icon: '📈', label: 'Risk' },
  event: { icon: '🗒', label: 'Events' },
};

// One line of text per timeline item.
export function describe(item) {
  switch (item.kind) {
    case 'checkin':
      return `${item.tier} check-in${item.weight != null ? ` · ${item.weight} lb` : ''}${item.flags?.length ? ` · ${item.flags.join('; ')}` : ''}${item.reporter === 'caregiver' ? ' (by caregiver)' : ''}`;
    case 'message':
      return `${item.direction === 'in' ? `${item.from ?? 'patient'} said` : `sent to ${item.to}`}: ${item.textEn ?? item.text}${item.delivery && item.delivery !== 'sent' && item.direction === 'out' ? ` [${item.delivery}]` : ''}`;
    case 'alert':
      return `${item.title ?? 'Alert'} · ${item.status}${item.source === 'ai_review' ? ' · AI review' : ''}`;
    case 'reading':
      return `${item.type} ${item.value} (${item.source})`;
    case 'risk':
      return `Risk ${item.score} · ${item.tier}`;
    default:
      return item.summary ?? item.type;
  }
}

const TIER_Y = { Low: 1, Med: 2, High: 3 };

export function RiskTrend({ patientId }) {
  const { data: rows, error, reload } = useLive(() => api.riskHistory(patientId), [patientId]);
  const chart = useMemo(() => (rows ?? []).map((r) => ({ at: timeOf(r.ts), score: r.score, tier: r.tier })), [rows]);
  return (
    <Card title="Risk over time">
      {error && !rows ? (
        <ErrorNotice what="risk history" error={error} onRetry={reload} />
      ) : chart.length < 2 ? (
        <Empty>{chart.length ? 'One reading so far; the trend appears after the next.' : 'No risk readings yet.'}</Empty>
      ) : (
        <ResponsiveContainer width="100%" height={140}>
          <LineChart data={chart} margin={{ left: -20, right: 8, top: 8 }}>
            <XAxis dataKey="at" hide />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v, _n, p) => [`${v} pts (${p.payload.tier})`, 'Risk']} />
            <ReferenceLine y={7} stroke="#ef4444" strokeDasharray="3 3" label={{ value: 'High', fontSize: 10, fill: '#ef4444' }} />
            <ReferenceLine y={4} stroke="#f59e0b" strokeDasharray="3 3" label={{ value: 'Med', fontSize: 10, fill: '#d97706' }} />
            <Line isAnimationActive={false} type="stepAfter" dataKey="score" stroke="#2563eb" strokeWidth={2} dot={{ r: 2 }} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

export default function TimelineCard({ patientId }) {
  const [shown, setShown] = useState(() => new Set(Object.keys(KIND_META).filter((k) => k !== 'risk')));
  const { data: items, error, reload } = useLive(() => api.timeline(patientId, { limit: 300 }), [patientId]);
  const toggle = (k) =>
    setShown((cur) => {
      const next = new Set(cur);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  const rows = (items ?? []).filter((i) => shown.has(i.kind));

  return (
    <Card title="Timeline" action={<span className="text-xs text-slate-500">{rows.length} of {items?.length ?? 0}</span>}>
      <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label="Show">
        {Object.entries(KIND_META).map(([k, m]) => (
          <button key={k} aria-pressed={shown.has(k)} onClick={() => toggle(k)} className={`rounded-full px-2.5 py-0.5 text-xs ring-1 ${shown.has(k) ? 'bg-blue-600 text-white ring-blue-600' : 'bg-white text-slate-600 ring-slate-300'}`}>
            {m.icon} {m.label}
          </button>
        ))}
      </div>
      {error && !items ? (
        <ErrorNotice what="the timeline" error={error} onRetry={reload} />
      ) : !items ? (
        <Empty>Loading…</Empty>
      ) : rows.length === 0 ? (
        <Empty>Nothing to show for these filters.</Empty>
      ) : (
        <ol className="max-h-96 space-y-1.5 overflow-y-auto border-l-2 border-slate-200 pl-3 text-sm">
          {rows.map((i, n) => (
            <li key={`${i.kind}-${i.ts}-${n}`} data-kind={i.kind}>
              <span className="text-xs text-slate-400">{timeOf(i.ts)}</span> <span aria-hidden>{KIND_META[i.kind]?.icon}</span>{' '}
              {i.tier && i.kind !== 'risk' && <TierBadge tier={i.tier} className="mr-1" />}
              <span className="text-slate-700">{describe(i)}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
