// Impact: is this worth adopting? Engagement, readmissions, nurse load, equity, and dollars.
// Data: GET /api/insights/* (M2), cohort + live patients, switchable with `source`.
import { useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid, Cell } from 'recharts';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { roi, ROI_DEFAULTS } from '../lib/roi.js';
import { money, compactMoney, pct, num, minutes, languageName } from '../lib/format.js';
import { Card, Stat, Empty, Button } from '../components/ui.jsx';

const SLA_TIERS = ['RED', 'YELLOW', 'INFO'];

const SOURCES = [
  ['all', 'Cohort + live'],
  ['cohort', 'Historical cohort'],
  ['live', 'Live demo'],
];

export default function Impact() {
  const [source, setSource] = useState('all');
  const { data, reload } = useLive(async () => {
    const [impact, engagement, equity, roiData] = await Promise.all(['impact', 'engagement', 'equity', 'roi'].map((n) => api.insight(n, { source })));
    return { impact, engagement, equity, roi: roiData };
  }, [source]);

  if (!data) return <Empty>Loading impact…</Empty>;
  const { impact, engagement, equity } = data;
  const r = impact.readmission;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-bold">Impact</h2>
        <div className="flex rounded-lg bg-slate-100 p-0.5">
          {SOURCES.map(([v, label]) => (
            <button key={v} onClick={() => setSource(v)} className={`rounded-md px-3 py-1 text-sm ${source === v ? 'bg-white font-medium shadow-sm' : 'text-slate-600'}`}>
              {label}
            </button>
          ))}
        </div>
        <span className="text-sm text-slate-500" title="Readmission rates only count patients whose 30-day outcome is known">
          {impact.patients} patients · {r.engaged.n + r.notEngaged.n} with 30-day outcomes
        </span>
        {source !== 'live' && (
          <span className="rounded-full bg-violet-100 px-2.5 py-0.5 text-xs font-semibold text-violet-800" title="Generated cohort for illustration; not real patient outcomes">
            Synthetic cohort · illustrative
          </span>
        )}
        <Button variant="subtle" className="ml-auto" onClick={async () => (await fetch('/api/insights/cohort/regenerate', { method: 'POST' }), reload())}>
          Regenerate cohort
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Readmitted: engaged" value={pct(r.engaged.rate, 1)} sub={`${r.engaged.readmitted}/${r.engaged.n} patients`} tone="green" />
        <Stat label="Readmitted: not engaged" value={pct(r.notEngaged.rate, 1)} sub={`${r.notEngaged.readmitted}/${r.notEngaged.n} patients`} tone="red" />
        <Stat label="Projected readmissions avoided" value={num(impact.projectedReadmissionsAvoided, 1)} sub="engaged vs not (correlational)" tone="blue" />
        <Stat label="Alerts / nurse / day" value={num(impact.alerts.perNursePerDay, 1)} sub={`precision ${pct(impact.alerts.precision)}`} />
        <Stat label="RED acknowledged" value={minutes(impact.alerts.medianMinutesToAckByTier.RED)} sub={`median · SLA 15 min · ${pct(impact.alerts.withinSlaByTier?.RED)} on time`} tone="violet" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="30-day readmission: engaged vs not">
          {r.engaged.rate == null && r.notEngaged.rate == null ? (
            <Empty>No outcomes yet for this source.</Empty>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={[{ name: 'Engaged (≥60% of days)', rate: r.engaged.rate ?? 0 }, { name: 'Not engaged', rate: r.notEngaged.rate ?? 0 }]} margin={{ left: -10 }}>
                <CartesianGrid stroke="#eef1f6" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={(v) => pct(v)} tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v) => pct(v, 1)} />
                <Bar isAnimationActive={false} dataKey="rate" name="Readmitted" radius={[6, 6, 0, 0]}>
                  <Cell fill="#10b981" />
                  <Cell fill="#ef4444" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title="Engagement by day since discharge (the drop-off that sank Tele-HF)">
          {engagement.byDay.length === 0 ? (
            <Empty>No check-in history yet.</Empty>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={engagement.byDay} margin={{ left: -10 }}>
                <CartesianGrid stroke="#eef1f6" />
                <XAxis dataKey="day" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 1]} tickFormatter={(v) => pct(v)} tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v) => pct(v, 1)} labelFormatter={(d) => `Day ${d}`} />
                <Legend />
                <Line isAnimationActive={false} dataKey="responseRate" name="Answered that day" stroke="#2563eb" strokeWidth={2.5} dot={false} />
                <Line isAnimationActive={false} dataKey="retention" name="Still engaged" stroke="#8b5cf6" strokeWidth={2} strokeDasharray="5 4" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
          <p className="mt-2 text-sm text-slate-600">
            The escalation ladder brought patients back <b>{engagement.ladder.recoveries}</b> times ({engagement.ladder.viaNudge} after a reminder, {engagement.ladder.viaCaregiver} via a caregiver).
          </p>
        </Card>

        <Card title="Equity: served as well in every language">
          <EquityChart equity={equity} />
        </Card>

        <Card title="Acknowledged within SLA, by tier (RED 15 min · YELLOW 4 h · INFO 24 h)">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={SLA_TIERS.map((t) => ({ tier: `${t} · median ${minutes(impact.alerts.medianMinutesToAckByTier[t])}`, share: impact.alerts.withinSlaByTier?.[t] ?? 0 }))} margin={{ left: -10 }}>
              <CartesianGrid stroke="#eef1f6" vertical={false} />
              <XAxis dataKey="tier" tick={{ fontSize: 12 }} />
              <YAxis domain={[0, 1]} tickFormatter={(v) => pct(v)} tick={{ fontSize: 12 }} />
              <Tooltip formatter={(v) => pct(v)} />
              <Bar isAnimationActive={false} dataKey="share" name="Acknowledged on time" radius={[6, 6, 0, 0]}>
                <Cell fill="#ef4444" />
                <Cell fill="#f59e0b" />
                <Cell fill="#94a3b8" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <RoiCalculator measured={data.roi.measured} />
    </div>
  );
}

function EquityChart({ equity }) {
  const rows = Object.entries(equity.byLanguage).map(([lang, v]) => ({ lang: languageName(lang), responseRate: v.responseRate, readmissionRate: v.readmissionRate, patients: v.patients }));
  if (!rows.length) return <Empty>No patients yet.</Empty>;
  return (
    <>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={rows} margin={{ left: -10 }}>
          <CartesianGrid stroke="#eef1f6" vertical={false} />
          <XAxis dataKey="lang" tick={{ fontSize: 12 }} />
          <YAxis domain={[0, 1]} tickFormatter={(v) => pct(v)} tick={{ fontSize: 12 }} />
          <Tooltip formatter={(v) => pct(v, 1)} />
          <Legend />
          <Bar isAnimationActive={false} dataKey="responseRate" name="Check-in response" fill="#2563eb" radius={[4, 4, 0, 0]} />
          <Bar isAnimationActive={false} dataKey="readmissionRate" name="Readmitted" fill="#f97316" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
      <p className="mt-2 text-sm text-slate-600">
        Response gap, English vs other languages: <b>{equity.responseGap == null ? '—' : `${(equity.responseGap * 100).toFixed(1)} pts`}</b>
      </p>
    </>
  );
}

// Interactive ROI. TCM/RPM rates start from what the data measured; everything is editable.
const FIELDS = [
  ['discharges', 'HF discharges / year', 50, 5000, 50, (v) => v.toLocaleString()],
  ['readmitRate', 'Baseline 30-day readmission', 0.05, 0.4, 0.005, (v) => pct(v, 1)],
  ['reduction', 'Relative reduction from HeartBridge', 0, 0.6, 0.01, (v) => pct(v)],
  ['costPerReadmit', 'Cost per readmission', 5000, 40000, 500, money],
  ['penaltyPct', 'HRRP penalty (% of Medicare pay)', 0, 0.03, 0.0005, (v) => pct(v, 2)],
  ['medicareRevenue', 'Medicare inpatient revenue', 5e6, 500e6, 5e6, compactMoney],
  ['tcmContactRate', 'Reached within 2 business days (TCM)', 0, 1, 0.01, (v) => pct(v)],
  ['rpmEligibleRate', '≥16 reading-days / month (RPM)', 0, 1, 0.01, (v) => pct(v)],
];

function RoiCalculator({ measured }) {
  const [inputs, setInputs] = useState(ROI_DEFAULTS);
  useEffect(() => {
    // Prefill from measured data once it arrives (only fields the data can speak to).
    setInputs((cur) => ({ ...cur, ...Object.fromEntries(Object.entries(measured ?? {}).filter(([, v]) => v != null)) }));
  }, [measured?.tcmContactRate, measured?.rpmEligibleRate]); // eslint-disable-line react-hooks/exhaustive-deps
  const out = useMemo(() => roi(inputs), [inputs]);
  const d = out.dollars;
  const parts = [
    ['Readmission costs avoided', d.readmissionCostAvoided, 'bg-emerald-500'],
    ['HRRP penalty avoided', d.penaltyAvoided, 'bg-blue-500'],
    ['TCM billing (99495/99496)', d.tcmRevenue, 'bg-violet-500'],
    ['RPM billing (99454 + 99457)', d.rpmRevenue, 'bg-amber-500'],
  ];

  return (
    <Card title="ROI calculator: annual value to the hospital">
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {FIELDS.map(([key, label, min, max, step, fmt]) => (
            <label key={key} className="text-sm">
              <div className="flex justify-between">
                <span className="text-slate-600">{label}</span>
                <span className="font-semibold tabular-nums">{fmt(inputs[key])}</span>
              </div>
              <input
                type="range"
                aria-label={label}
                min={min}
                max={max}
                step={step}
                value={inputs[key]}
                onChange={(e) => setInputs({ ...inputs, [key]: Number(e.target.value) })}
                className="w-full accent-blue-600"
              />
            </label>
          ))}
        </div>
        <div className="rounded-xl bg-slate-900 p-5 text-white">
          <div className="text-sm uppercase tracking-wide text-slate-400">Total annual value</div>
          <div className="mt-1 text-4xl font-bold tabular-nums" data-testid="roi-total">{money(d.total)}</div>
          <div className="mt-1 text-sm text-slate-400">{num(out.readmissionsAvoided, 1)} readmissions avoided per year</div>
          <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-slate-700">
            {parts.map(([label, v, color]) => (
              <div key={label} className={color} style={{ width: `${d.total ? (v / d.total) * 100 : 0}%` }} />
            ))}
          </div>
          <ul className="mt-3 space-y-1 text-sm">
            {parts.map(([label, v, color]) => (
              <li key={label} className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-sm ${color}`} />
                <span className="text-slate-300">{label}</span>
                <span className="ml-auto tabular-nums">{money(v)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-slate-400">Defaults and sources: docs/STRATEGY.md. The HRRP penalty is assumed to shrink in proportion to the reduction.</p>
        </div>
      </div>
    </Card>
  );
}
