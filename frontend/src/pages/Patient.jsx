// Patient view: everything about one patient, and why the system did what it did.
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer, CartesianGrid } from 'recharts';
import { api } from '../api.js';
import { useLive, useNow } from '../hooks.js';
import { useHealth } from '../App.jsx';
import { formatDuration } from '../lib/worklist.js';
import { languageName, shortDate, timeOf, pct } from '../lib/format.js';
import { Card, Empty, ErrorNotice, TierBadge, RiskBadge, Button, AsyncButton, KindBadge, TREND_ICON } from '../components/ui.jsx';
import PhoneSimulator from '../components/PhoneSimulator.jsx';
import { AiBrief } from '../components/AlertCard.jsx';
import DebugDrawer from '../components/DebugDrawer.jsx';
import ExportDialog from '../components/ExportDialog.jsx';

const DAY = 86400000;

export default function Patient() {
  const { id } = useParams();
  const { data: p, error, reload } = useLive(() => api.patient(id), [id]);
  const [role, setRole] = useState('patient');

  if (error?.status === 404) return <Empty>No patient with id “{id}”. <Link to="/" className="text-blue-700 underline">Back to the worklist</Link></Empty>;
  if (!p) return error ? <ErrorNotice what="this patient" error={error} onRetry={reload} /> : <Empty>Loading…</Empty>;

  return (
    <div className="space-y-4">
      {error && <ErrorNotice what="this patient" error={error} onRetry={reload} stale />}
      <Header p={p} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem] xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="min-w-0 space-y-4">
          <RiskCard p={p} />
          <WeightChart p={p} />
          <div className="grid gap-4 md:grid-cols-2">
            <CheckinTimeline p={p} />
            <WhyPanel p={p} />
          </div>
          <AdherenceHeatmap p={p} />
          <div className="grid gap-4 md:grid-cols-3">
            <Prescriptions p={p} />
            <SocialNeeds p={p} />
            <Lessons p={p} />
          </div>
        </div>
        <div className="space-y-4">
          <Card title="Conversation" action={<AsyncButton variant="ghost" onClick={() => api.startCheckin(p.id)}>▶ Start check-in</AsyncButton>}>
            <PhoneSimulator patient={p} messages={p.messages ?? []} role={role} onRoleChange={setRole} />
          </Card>
        </div>
      </div>
      <DebugDrawer audit={p.audit} patientName={p.name.split(' ')[0]} />
    </div>
  );
}

// The non-response ladder, made visible: "No reply yet. Priya will be asked to check in in
// 01:59:32". Counts down on the demo clock, so "+6h" on the Demo page visibly fires it.
const RUNG_LABEL = {
  1: (p) => `Reminder to ${p.name.split(' ')[0]}`,
  2: (p) => (p.caregiver?.name ? `${p.caregiver.name.split(' ')[0]} (${p.caregiver.relation ?? 'caregiver'}) asked to check in` : 'Caregiver asked to check in'),
  3: () => 'Nurse task: unreachable',
};
function SilentAlarm({ p }) {
  const health = useHealth();
  const now = useNow(1000, health?.demoOffsetMs ?? 0);
  const { data: jobs } = useLive(() => api.jobs({ patientId: p.id, kind: 'outreach_step', status: 'pending' }).catch(() => []), [p.id]);
  const next = (jobs ?? []).find((j) => Date.parse(j.dueAt) > now - 60_000);
  if (!next) return null;
  const label = RUNG_LABEL[next.payload?.rung]?.(p) ?? 'Next outreach step';
  return (
    <div className="w-full rounded-lg bg-amber-50 px-3 py-1.5 text-sm text-amber-900" role="status">
      📵 No reply to today's check-in yet · <b>{label}</b> in <span className="font-mono tabular-nums">{formatDuration(Math.max(0, Date.parse(next.dueAt) - now))}</span>
    </div>
  );
}

function Header({ p }) {
  const s = p.signals ?? {};
  const [exporting, setExporting] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div>
        <h2 className="text-2xl font-bold">
          {p.name}
          {p.source === 'fhir' && <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 align-middle text-xs font-medium text-blue-700">from EHR</span>}
        </h2>
        <div className="text-sm text-slate-500">
          {p.age != null ? `${p.age}y` : 'age unknown'} · {languageName(p.language)} · day {s.daysSinceDischarge ?? '—'} since discharge ({shortDate(p.dischargedAt)}) · dry weight {p.dryWeightLb ?? '—'} lb
          {p.contactPhone && <> · 📞 {p.contactPhone}</>}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase text-slate-500">Risk</span>
        <RiskBadge tier={p.riskTier} trend={p.riskDynamic?.trend} detail={` · ${p.riskScore ?? '—'} pts`} className="text-sm" />
        {p.lastTier && (
          <>
            <span className="ml-2 text-xs uppercase text-slate-500">Last check-in</span>
            <TierBadge tier={p.lastTier} className="text-sm" />
          </>
        )}
      </div>
      <Button variant="ghost" className="ml-auto" onClick={() => setExporting(true)}>
        ⤴ Export to EHR
      </Button>
      {exporting && <ExportDialog patient={p} onClose={() => setExporting(false)} />}
      <div className="text-right text-sm">
        <div className="text-xs uppercase text-slate-500">Caregiver</div>
        {p.caregiver?.name ? (
          <div>
            {p.caregiver.name} ({p.caregiver.relation}) {p.caregiver.chatId ? '📱' : ''} {p.caregiverConsent === false && <span className="text-amber-700">· no consent</span>}
          </div>
        ) : (
          <div className="text-slate-400">none</div>
        )}
      </div>
      <SilentAlarm p={p} />
    </div>
  );
}

// Baseline (discharge) vs dynamic (how they're doing) factors. Dynamic ones appear once the
// core stores Risk v2 results on the patient (riskDynamic / riskFactors with dynamic labels).
function RiskCard({ p }) {
  const dynamic = p.riskDynamic?.factors ?? [];
  const dynLabels = new Set(dynamic.map((f) => f.label));
  const baseline = (p.riskBaseline?.factors ?? p.riskFactors ?? []).filter((f) => !dynLabels.has(f.label));
  const Factor = ({ f, tone }) => (
    <span className={`rounded-md px-2 py-1 text-sm ${tone}`}>
      {f.label} <b>+{f.points}</b>
    </span>
  );
  return (
    <Card title="Why this risk tier" action={p.riskDynamic?.trend && <span className="text-sm text-slate-500">trend {TREND_ICON[p.riskDynamic.trend]} {p.riskDynamic.trend}</span>}>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <div className="mb-1.5 text-xs font-medium text-slate-500">Baseline (at discharge)</div>
          <div className="flex flex-wrap gap-1.5">{baseline.length ? baseline.map((f) => <Factor key={f.label} f={f} tone="bg-slate-100" />) : <span className="text-sm text-slate-400">none</span>}</div>
        </div>
        <div>
          <div className="mb-1.5 text-xs font-medium text-slate-500">Dynamic (since discharge)</div>
          <div className="flex flex-wrap gap-1.5">
            {dynamic.length ? dynamic.map((f) => <Factor key={f.label} f={f} tone="bg-amber-50 text-amber-900" />) : <span className="text-sm text-slate-400">nothing concerning yet</span>}
          </div>
        </div>
      </div>
    </Card>
  );
}

function WeightChart({ p }) {
  const data = (p.weights ?? []).map((w) => ({ day: shortDate(w.ts), lb: w.lb }));
  const dry = p.dryWeightLb;
  if (!data.length) return <Card title="Daily weight"><Empty>No weights yet.</Empty></Card>;
  const values = data.map((d) => d.lb).concat(dry ? [dry, dry + 5] : []);
  return (
    <Card title="Daily weight (lb)">
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 8, right: 40, bottom: 0, left: -10 }}>
          <CartesianGrid stroke="#eef1f6" />
          <XAxis dataKey="day" tick={{ fontSize: 12 }} />
          <YAxis domain={[Math.floor(Math.min(...values) - 1), Math.ceil(Math.max(...values) + 1)]} tick={{ fontSize: 12 }} />
          <Tooltip />
          {dry && <ReferenceLine y={dry} stroke="#10b981" strokeDasharray="4 4" label={{ value: 'dry', position: 'right', fontSize: 11 }} />}
          {dry && <ReferenceLine y={dry + 2} stroke="#f59e0b" strokeDasharray="4 4" label={{ value: '+2', position: 'right', fontSize: 11 }} />}
          {dry && <ReferenceLine y={dry + 5} stroke="#ef4444" strokeDasharray="4 4" label={{ value: '+5', position: 'right', fontSize: 11 }} />}
          <Line isAnimationActive={false} type="monotone" dataKey="lb" stroke="#2563eb" strokeWidth={2.5} dot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    </Card>
  );
}

const ANSWER_LABELS = { weightLb: (v) => `${v} lb`, breath: (v) => `breath: ${v}`, orthopnea: (v) => (v ? 'extra pillows' : null), pnd: (v) => (v ? 'woke up breathless' : null), swelling: (v) => `swelling: ${v}`, chestPain: (v) => (v ? 'chest pain' : null), dizzy: (v) => (v ? 'dizzy' : null), confusion: (v) => (v ? 'confused' : null), fainting: (v) => (v ? 'fainted' : null), diureticTaken: (v) => (v ? 'took water pill' : 'missed water pill'), spo2: (v) => `SpO₂ ${v}%` };
const summarize = (a = {}) => Object.entries(ANSWER_LABELS).map(([k, f]) => (a[k] != null ? f(a[k]) : null)).filter(Boolean);

function CheckinTimeline({ p }) {
  const items = [...(p.checkins ?? [])].reverse();
  return (
    <Card title="Check-ins">
      {items.length === 0 ? (
        <Empty>No check-ins yet.</Empty>
      ) : (
        <ol className="max-h-80 space-y-2 overflow-y-auto">
          {items.map((c, i) => (
            <li key={c.ts + i} className="flex items-start gap-2 text-sm">
              <TierBadge tier={c.tier} />
              <div className="min-w-0">
                <div className="text-xs text-slate-500">{timeOf(c.ts)}{c.reporter === 'caregiver' && ' · by caregiver'}</div>
                <div className="text-slate-700">{summarize(c.answers).join(' · ') || '—'}</div>
                {c.flags?.length > 0 && <div className="text-xs text-red-700">{c.flags.map((f) => f.text ?? f).join('; ')}</div>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

// The explainability panel: every decision with its inputs, from the audit log + alert reasons.
const AUDIT_LABEL = { triage: '🩺 Triage', escalation: '🚨 Escalation', nurse_action: '👩‍⚕️ Nurse', enroll: '📝 Enrolled', device_reading: '📟 Device', photo_received: '📷 Photo', outreach: '📣 Outreach', outreach_recovered: '↩️ Recovered', refill_nudge: '💊 Refill nudge', refill_barrier: '💊 Refill barrier', llm_parse: '🤖 AI parse', ai_review: '🤖 AI review', fhir_import: '🏥 EHR import', risk: '📈 Risk', parse_trace: '🔍 Read', red_lock: '🚨 RED lock', protocol_applied: '💊 Standing order', injection_attempt: '🛡️ Injection blocked', tier_cleared: '↩️ False alarm', scenario: '🎬 Scenario', vital_reported: '🩺 Vital', companion: '💬 Companion' };

export function auditSummary(e) {
  const d = e.data ?? {};
  const parts = [];
  if (e.type === 'parse_trace') {
    const read = Object.entries(d.rules ?? {}).filter(([k]) => !/Asked|Pending/.test(k)).map(([k, v]) => `${k}=${v}`);
    return [d.text ? `“${d.text}”` : d.button, read.length && `rules read ${read.join(', ')}`, d.llm && (d.llm.timedOut ? 'AI timed out' : 'AI consulted'), d.outcome?.tier].filter(Boolean).join(' · ');
  }
  if (d.tier) parts.push(d.tier);
  const flags = d.flags ?? d.reasons;
  if (Array.isArray(flags) && flags.length) parts.push(flags.map((f) => f.text ?? f).join('; '));
  if (d.status) parts.push(d.status);
  if (d.outcome) parts.push(`outcome: ${d.outcome}`);
  if (d.event) parts.push(d.event.replace(/_/g, ' '));
  if (d.rung) parts.push(`rung ${d.rung}`);
  if (d.med) parts.push(d.med);
  if (d.barrier) parts.push(d.barrier);
  if (d.note) parts.push(`“${d.note}”`);
  if (d.fhirId) parts.push(`FHIR ${d.fhirId}${d.conditions?.length ? ` · ${d.conditions.join(', ')}` : ''}`);
  return parts.join(' · ') || Object.keys(d).slice(0, 3).map((k) => `${k}: ${typeof d[k] === 'object' ? '…' : d[k]}`).join(', ');
}

function WhyPanel({ p }) {
  const audit = [...(p.audit ?? [])].reverse().slice(0, 40);
  const alerts = [...(p.alerts ?? [])].reverse();
  return (
    <Card title="Why: decisions & evidence">
      {alerts.length === 0 && audit.length === 0 && <Empty>No decisions yet.</Empty>}
      <div className="max-h-80 space-y-3 overflow-y-auto">
        {alerts.map((a) => (
          <div key={a.id} className="rounded-lg bg-slate-50 p-2 text-sm">
            <div className="flex items-center gap-2">
              <TierBadge tier={a.tier} /> <KindBadge alert={a} />
              <span className="ml-auto text-xs capitalize text-slate-500">{a.status}{a.outcome ? ` · ${a.outcome.replace(/_/g, ' ')}` : ''}</span>
            </div>
            <ul className="mt-1 list-disc pl-5 text-slate-700">{(a.reasons ?? []).map((r, i) => <li key={i}>{r}</li>)}</ul>
            <AiBrief alert={a} />
          </div>
        ))}
        {audit.length > 0 && (
          <ol className="space-y-1 border-l-2 border-slate-200 pl-3 text-xs">
            {audit.map((e) => (
              <li key={e.id}>
                <span className="text-slate-400">{timeOf(e.ts)}</span> <b>{AUDIT_LABEL[e.type] ?? e.type}</b> <span className="text-slate-600">{auditSummary(e)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}

// Meds x last 14 days. Green = taken, red = missed, grey = asked but unanswered, blank = not due.
export function adherenceGrid(doses = [], meds = [], endMs, days = 14) {
  const start = new Date(endMs - (days - 1) * DAY).toISOString().slice(0, 10);
  const dayKeys = Array.from({ length: days }, (_, i) => new Date(Date.parse(start) + i * DAY).toISOString().slice(0, 10));
  const names = [...new Set([...meds.map((m) => m.name), ...doses.map((d) => d.med)])].filter(Boolean);
  return {
    days: dayKeys,
    rows: names.map((name) => ({
      name,
      cells: dayKeys.map((day) => {
        const ds = doses.filter((d) => d.med === name && d.ts.slice(0, 10) === day);
        if (!ds.length) return 'none';
        if (ds.some((d) => d.taken === false)) return 'missed';
        if (ds.every((d) => d.taken === true)) return 'taken';
        return 'unanswered';
      }),
    })),
  };
}

const CELL = { taken: 'bg-emerald-500', missed: 'bg-red-500', unanswered: 'bg-slate-300', none: 'bg-slate-100' };

function AdherenceHeatmap({ p }) {
  const health = useHealth();
  const today = Date.now() + (health?.demoOffsetMs ?? 0); // demo clock, like the rest of the app
  const end = p.signals?.lastCheckinAt ? Math.max(today, Date.parse(p.signals.lastCheckinAt)) : today;
  const grid = adherenceGrid(p.doses, p.meds, end);
  const rate = p.signals?.adherence7d;
  return (
    <Card title="Medication adherence (14 days)" action={<span className="text-sm text-slate-500">7-day adherence {pct(rate)}</span>}>
      {grid.rows.length === 0 ? (
        <Empty>No medications on file.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="text-xs">
            <tbody>
              {grid.rows.map((r) => (
                <tr key={r.name}>
                  <th className="pr-3 text-left font-medium text-slate-700">{r.name}</th>
                  {r.cells.map((c, i) => (
                    <td key={i} className="p-0.5">
                      <div role="img" aria-label={`${r.name}, ${grid.days[i]}: ${c}`} title={`${grid.days[i]}: ${c}`} className={`h-5 w-5 rounded ${CELL[c]}`} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 flex gap-3 text-xs text-slate-500">
            {Object.entries(CELL).map(([k, v]) => (
              <span key={k} className="flex items-center gap-1">
                <span className={`inline-block h-3 w-3 rounded ${v}`} />
                {k}
              </span>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function Prescriptions({ p }) {
  const rxs = p.prescriptions ?? [];
  return (
    <Card title="Prescriptions">
      {rxs.length === 0 ? (
        <Empty>None on file.</Empty>
      ) : (
        <ul className="space-y-2 text-sm">
          {rxs.map((rx) => (
            <li key={rx.med} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{rx.med}</span>
              {rx.pickedUpAt ? (
                <span className="text-emerald-700">✓ picked up {shortDate(rx.pickedUpAt)}</span>
              ) : (
                <>
                  <span className="font-semibold text-red-700">⚠ not picked up</span>
                  <span className="ml-auto">
                    <AsyncButton variant="subtle" className="!px-2 !py-0.5 text-xs" onClick={() => api.pickedUp(p.id, rx.med)}>
                      Mark picked up
                    </AsyncButton>
                  </span>
                </>
              )}
              {rx.barrier && <span className="w-full text-xs text-amber-800">Barrier: {rx.barrier}</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SocialNeeds({ p }) {
  const flags = p.sdoh?.flags ?? p.signals?.sdohFlags ?? [];
  return (
    <Card title="Social needs">
      {flags.length ? (
        <div className="flex flex-wrap gap-1.5">{flags.map((f) => <span key={f} className="rounded-md bg-amber-50 px-2 py-1 text-sm text-amber-900">{f.replace(/_/g, ' ')}</span>)}</div>
      ) : (
        <Empty>No social needs flagged yet.</Empty>
      )}
    </Card>
  );
}

function Lessons({ p }) {
  const score = p.lessons?.score ?? p.signals?.lessonScore;
  return (
    <Card title="Self-care lessons">
      {score == null ? <Empty>No lessons completed yet.</Empty> : <div className="text-3xl font-bold">{pct(score)}</div>}
    </Card>
  );
}
