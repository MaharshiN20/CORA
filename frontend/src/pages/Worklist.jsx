// Worklist: every open alert and task, most urgent first (tier -> SLA -> risk), with live
// SLA countdowns and the Acknowledge -> Contacted -> Resolve flow. Side panel: patients.
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api.js';
import { useLive, useNow } from '../hooks.js';
import { useHealth } from '../App.jsx';
import { sortWorklist, filterWorklist, KINDS, TIER_RANK } from '../lib/worklist.js';
import { languageName } from '../lib/format.js';
import AlertCard from '../components/AlertCard.jsx';
import { Card, Empty, TierBadge, Button, TREND_ICON } from '../components/ui.jsx';

const LAST_TIER_RANK = { RED: 0, YELLOW: 1, GREEN: 2 };

export default function Worklist() {
  const { data } = useLive(async () => {
    const [alerts, patients] = await Promise.all([api.alerts(), api.patients()]);
    return { alerts, patients };
  });
  const health = useHealth();
  const now = useNow(1000, health?.demoOffsetMs ?? 0);
  const [kind, setKind] = useState('all');
  const [tier, setTier] = useState('all');

  const patientsById = useMemo(() => Object.fromEntries((data?.patients ?? []).map((p) => [p.id, p])), [data]);
  const open = useMemo(() => sortWorklist(data?.alerts ?? [], patientsById), [data, patientsById]);
  const shown = filterWorklist(open, { kind, tier });
  const counts = Object.fromEntries(['RED', 'YELLOW', 'INFO'].map((t) => [t, open.filter((a) => a.tier === t).length]));
  const overdue = open.filter((a) => Date.parse(a.dueBy) < now).length;

  if (!data) return <Empty>Loading worklist…</Empty>;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-bold">Worklist</h2>
          <span className="text-sm text-slate-500">
            {open.length} open · <span className="font-semibold text-red-700">{counts.RED} RED</span> · <span className="font-semibold text-amber-700">{counts.YELLOW} YELLOW</span> · {counts.INFO} INFO
            {overdue > 0 && <span className="ml-2 rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white">{overdue} overdue</span>}
          </span>
          <div className="ml-auto flex gap-2">
            <select aria-label="Filter by kind" value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm">
              <option value="all">All kinds</option>
              {Object.entries(KINDS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.icon} {v.label}
                </option>
              ))}
            </select>
            <select aria-label="Filter by tier" value={tier} onChange={(e) => setTier(e.target.value)} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm">
              <option value="all">All tiers</option>
              {Object.keys(TIER_RANK).map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
        </div>
        {shown.length === 0 ? (
          <Card>
            <Empty>{open.length ? 'Nothing matches these filters.' : '🎉 Nothing needs attention right now.'}</Empty>
          </Card>
        ) : (
          shown.map((a) => <AlertCard key={a.id} alert={a} patient={patientsById[a.patientId]} now={now} />)
        )}
      </div>

      <aside className="space-y-3">
        <PatientPanel patients={data.patients} />
        <MessageBox patients={data.patients} />
      </aside>
    </div>
  );
}

function PatientPanel({ patients }) {
  const sorted = [...patients].sort(
    (a, b) => (LAST_TIER_RANK[a.lastTier] ?? 3) - (LAST_TIER_RANK[b.lastTier] ?? 3) || (b.riskScore ?? 0) - (a.riskScore ?? 0),
  );
  return (
    <Card title={`Patients (${patients.length})`}>
      <ul className="-mx-2 divide-y divide-slate-100">
        {sorted.map((p) => (
          <li key={p.id}>
            <Link to={`/patients/${p.id}`} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-slate-50">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{p.name}</div>
                <div className="text-xs text-slate-500">
                  {p.age}y · {languageName(p.language)} · day {p.signals?.daysSinceDischarge ?? '—'}
                  {p.signals?.missedCheckins7d > 0 && <span className="text-amber-700"> · {p.signals.missedCheckins7d} missed</span>}
                </div>
              </div>
              {p.lastTier && <TierBadge tier={p.lastTier} />}
              <TierBadge tier={p.riskTier} suffix={p.riskDynamic?.trend ? ` ${TREND_ICON[p.riskDynamic.trend]}` : ''} />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// Nurse -> patient message, delivered on the patient's channel in their language.
function MessageBox({ patients }) {
  const [patientId, setPatientId] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState(null);
  const send = async (e) => {
    e.preventDefault();
    if (!patientId || !text.trim()) return;
    setStatus('sending');
    try {
      await api.message(patientId, text.trim());
      setText('');
      setStatus('sent');
    } catch (err) {
      setStatus(err.status === 404 ? 'Messaging is not available on this backend yet.' : err.message);
    }
  };
  return (
    <Card title="Message a patient">
      <form onSubmit={send} className="space-y-2">
        <select aria-label="Patient" value={patientId} onChange={(e) => setPatientId(e.target.value)} className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm">
          <option value="">Choose a patient…</option>
          {patients.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({languageName(p.language)})
            </option>
          ))}
        </select>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Written in English, sent in the patient's language" className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
        <div className="flex items-center gap-2">
          <Button disabled={!patientId || !text.trim() || status === 'sending'}>Send</Button>
          {status && status !== 'sending' && <span className={`text-xs ${status === 'sent' ? 'text-emerald-700' : 'text-red-700'}`}>{status === 'sent' ? 'Sent ✓' : status}</span>}
        </div>
      </form>
    </Card>
  );
}
