// Worklist: every open alert and task, most urgent first (tier -> SLA -> risk), with live
// SLA countdowns and the Acknowledge -> Contacted -> Resolve flow. Side panel: patients.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Siren } from 'lucide-react';
import { Link } from 'react-router';
import { api } from '../api.js';
import { useLive, useNow, useNurse } from '../hooks.js';
import { useHealth } from '../App.jsx';
import { sortWorklist, filterWorklist, messageOutcome, stabilize, silentPatients, bulkable, bulkBodies, bulkOutcome, KINDS, TIER_RANK, SORTS } from '../lib/worklist.js';
import { canNotify, notifyPermission, enableNotifications, notifyRed, titleFor } from '../lib/notify.js';
import { languageName } from '../lib/format.js';
import AlertCard from '../components/AlertCard.jsx';
import Wallboard from '../components/Wallboard.jsx';
import ImportDialog from '../components/ImportDialog.jsx';
import { Card, Empty, ErrorNotice, TierBadge, RiskBadge, Button } from '../components/ui.jsx';

const LAST_TIER_RANK = { RED: 0, YELLOW: 1, GREEN: 2 };

// Alerts that arrived while the page is open: flash their card once and toast the newest,
// so a nurse (or a judge) sees the RED land instead of hunting for it.
function useArrivals(open, patientsById = {}) {
  const seen = useRef(null);
  const timers = useRef([]);
  const [fresh, setFresh] = useState([]);
  const [toast, setToast] = useState(null);
  useEffect(() => {
    if (!open) return; // not loaded yet
    if (seen.current == null) {
      seen.current = new Set(open.map((a) => a.id)); // first load: nothing is "new"
      return;
    }
    const added = open.filter((a) => !seen.current.has(a.id));
    for (const a of added) seen.current.add(a.id);
    if (!added.length) return;
    setFresh(added.map((a) => a.id));
    setToast(added.find((a) => a.tier === 'RED') ?? added[0]);
    // A nurse in another window still hears about a new RED (if they allowed notifications).
    for (const a of added) if (a.tier === 'RED') notifyRed(a, patientsById[a.patientId]?.name ?? a.patientId);
    timers.current.push(setTimeout(() => setFresh([]), 1800), setTimeout(() => setToast(null), 6000));
  }, [open]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return { fresh, toast, dismiss: () => setToast(null) };
}

const scrollToAlert = (id) => document.getElementById(`alert-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });

export default function Worklist() {
  const { data, error, reload } = useLive(async () => {
    const [alerts, patients] = await Promise.all([api.alerts(), api.patients()]);
    return { alerts, patients };
  });
  const health = useHealth();
  // Coarse: only the "N overdue" counter needs it. Each card's own countdown ticks by itself.
  const now = useNow(15_000, health?.demoOffsetMs ?? 0);
  const memo = useRef(new Map());
  const [kind, setKind] = useState('all');
  const [tier, setTier] = useState('all');
  const [status, setStatus] = useState('all');
  const [assignee, setAssignee] = useState('all');
  const [sort, setSort] = useState('urgency');
  const [q, setQ] = useState('');
  const [me] = useNurse();
  const [alertsPerm, setAlertsPerm] = useState(notifyPermission);

  const patientsById = useMemo(() => Object.fromEntries((data?.patients ?? []).map((p) => [p.id, p])), [data]);
  const stableAlerts = useMemo(() => stabilize(memo.current, data?.alerts), [data]);
  const open = useMemo(() => sortWorklist(stableAlerts, patientsById, sort), [stableAlerts, patientsById, sort]);
  const shown = filterWorklist(open, { kind, tier, status, assignee, me, q, patientsById });
  const counts = Object.fromEntries(['RED', 'YELLOW', 'INFO'].map((t) => [t, open.filter((a) => a.tier === t).length]));
  const overdue = open.filter((a) => Date.parse(a.dueBy) < now).length;
  const reds = open.filter((a) => a.tier === 'RED' && (a.kind ?? 'triage') === 'triage');
  const redNames = [...new Set(reds.map((a) => patientsById[a.patientId]?.name?.split(' ')[0] ?? a.patientId))];
  const { fresh, toast, dismiss } = useArrivals(data ? open : null, patientsById);
  // The tab title carries the RED count, for a nurse working in another tab.
  useEffect(() => {
    document.title = titleFor(reds.length);
    return () => {
      document.title = titleFor(0);
    };
  }, [reds.length]);
  const filtering = kind !== 'all' || tier !== 'all' || status !== 'all' || assignee !== 'all' || q.trim() !== '';

  // Bulk actions: checkboxes on the routine (YELLOW / INFO) cards. Only what is selected AND on
  // screen is ever acted on, so a filter can't hide an alert that is about to be changed.
  const [selected, setSelected] = useState(() => new Set());
  const [bulk, setBulk] = useState(null); // { busy } | { tone, text }
  const toggle = useCallback((id, on) => {
    setBulk(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const selectable = shown.filter(bulkable);
  const chosen = selectable.filter((a) => selected.has(a.id));
  const runBulk = async (action) => {
    setBulk({ busy: true });
    try {
      const responses = [];
      for (const body of bulkBodies(chosen, action, me)) responses.push(await api.updateAlerts(body));
      const { failedIds, ...outcome } = bulkOutcome(responses);
      setBulk(outcome);
      setSelected(new Set(failedIds));
      reload();
    } catch (e) {
      setBulk({ tone: 'error', text: e.message });
    }
  };

  if (!data) return error ? <ErrorNotice what="the worklist" error={error} onRetry={reload} /> : <Empty>Loading worklist…</Empty>;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem] projector:lg:grid-cols-1">
      <div className="min-w-0 space-y-3">
        {error && <ErrorNotice what="the worklist" error={error} onRetry={reload} stale />}
        {reds.length > 0 && (
          <button onClick={() => scrollToAlert(reds[0].id)} className="flex w-full items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-left font-semibold text-white shadow-md hover:bg-red-700 projector:text-lg" role="alert">
            <Siren className="animate-pulse" size={20} aria-hidden />
            {redNames.length} {redNames.length === 1 ? 'patient was' : 'patients were'} told to call 911: {redNames.join(', ')}. Call now.
          </button>
        )}
        <Wallboard alerts={open} patientsById={patientsById} now={now} onJump={scrollToAlert} />
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-bold">Worklist</h2>
          <span className="text-sm text-slate-500">
            {open.length} open · <span className="font-semibold text-red-700">{counts.RED} RED</span> · <span className="font-semibold text-amber-700">{counts.YELLOW} YELLOW</span> · {counts.INFO} INFO
            {overdue > 0 && <span className="ml-2 rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white">{overdue} overdue</span>}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <input type="search" aria-label="Search the worklist" placeholder="Search patient, reason, nurse…" value={q} onChange={(e) => setQ(e.target.value)} className="w-52 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm" />
            <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm">
              <option value="all">Any status</option>
              <option value="open">Open</option>
              <option value="acknowledged">Acknowledged</option>
              <option value="contacted">Contacted</option>
            </select>
            <select aria-label="Filter by assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm">
              <option value="all">Anyone</option>
              <option value="mine" disabled={!me}>
                {me ? `Mine (${me})` : 'Mine (set your name)'}
              </option>
              <option value="unassigned">Unassigned</option>
            </select>
            <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm">
              {SORTS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
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
        {selectable.length > 0 && (
          <BulkBar
            total={selectable.length}
            chosen={chosen}
            me={me}
            state={bulk}
            onAll={(on) => (setBulk(null), setSelected(on ? new Set(selectable.map((a) => a.id)) : new Set()))}
            onRun={runBulk}
          />
        )}
        {shown.length === 0 ? (
          <Card>
            <Empty>{open.length ? 'Nothing matches these filters.' : '🎉 Nothing needs attention right now.'}</Empty>
            {filtering && open.length > 0 && (
              <div className="text-center">
                <Button variant="subtle" onClick={() => (setKind('all'), setTier('all'), setStatus('all'), setAssignee('all'), setQ(''))}>
                  Clear filters
                </Button>
              </div>
            )}
          </Card>
        ) : (
          <div className="space-y-3 projector:grid projector:grid-cols-2 projector:items-start projector:gap-3 projector:space-y-0">
            {shown.map((a) => (
              <AlertCard key={a.id} alert={a} patient={patientsById[a.patientId]} highlight={fresh.includes(a.id)} selected={selected.has(a.id)} onSelect={toggle} />
            ))}
          </div>
        )}
      </div>

      <aside className="space-y-3 projector:hidden">
        {canNotify() && alertsPerm !== 'granted' && alertsPerm !== 'denied' && (
          <Button variant="subtle" className="w-full" onClick={async () => setAlertsPerm(await enableNotifications())}>
            🔔 Get desktop alerts for new RED cases
          </Button>
        )}
        <PatientPanel patients={data.patients} />
        <MessageBox patients={data.patients} />
      </aside>

      {toast && (
        <div className={`toast-in fixed bottom-5 right-5 z-30 flex max-w-sm items-start gap-3 rounded-xl p-3 text-sm shadow-2xl ${toast.tier === 'RED' ? 'bg-red-600 text-white' : 'bg-slate-900 text-white'}`} role="status">
          <button className="text-left" onClick={() => (scrollToAlert(toast.id), dismiss())}>
            <div className="font-semibold">
              New {toast.tier} · {patientsById[toast.patientId]?.name ?? toast.patientId}
            </div>
            <div className="opacity-90">{toast.title}</div>
          </button>
          <button onClick={dismiss} aria-label="Dismiss" className="ml-auto opacity-70 hover:opacity-100">
            ×
          </button>
        </div>
      )}
    </div>
  );
}

// Select-all plus the two bulk actions. RED alerts are not counted and have no checkbox: an
// emergency is acknowledged one at a time, by someone who has read it.
function BulkBar({ total, chosen, me, state, onAll, onRun }) {
  const all = useRef(null);
  const n = chosen.length;
  useEffect(() => {
    if (all.current) all.current.indeterminate = n > 0 && n < total;
  }, [n, total]);
  const busy = !!state?.busy;
  const canAck = chosen.some((a) => a.status === 'open');
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm projector:hidden" role="group" aria-label="Bulk actions">
      <label className="flex cursor-pointer items-center gap-2 text-slate-600">
        <input ref={all} type="checkbox" className="h-4 w-4 accent-blue-600" checked={n > 0 && n === total} onChange={(e) => onAll(e.target.checked)} aria-label={`Select all ${total} routine alerts shown`} />
        {n ? `${n} selected` : `Select routine alerts (${total})`}
      </label>
      {n > 0 && (
        <>
          <Button onClick={() => onRun('acknowledge')} disabled={busy || !canAck} title={canAck ? undefined : 'None of the selected alerts is still open'}>
            Acknowledge selected
          </Button>
          <Button variant="ghost" onClick={() => onRun('assign')} disabled={busy || !me} title={me ? undefined : 'Set your name (top right) first'}>
            Assign selected to me
          </Button>
          <Button variant="subtle" onClick={() => onAll(false)} disabled={busy}>
            Clear
          </Button>
        </>
      )}
      {state?.text && (
        <span role="status" className={`text-xs ${state.tone === 'ok' ? 'text-emerald-700' : state.tone === 'warn' ? 'text-amber-700' : 'text-red-700'}`}>
          {state.text}
        </span>
      )}
      <span className="ml-auto text-xs text-slate-400">RED alerts are handled one at a time</span>
    </div>
  );
}

function PatientPanel({ patients }) {
  const sorted = [...patients].sort(
    (a, b) => (LAST_TIER_RANK[a.lastTier] ?? 3) - (LAST_TIER_RANK[b.lastTier] ?? 3) || (b.riskScore ?? 0) - (a.riskScore ?? 0),
  );
  const [importing, setImporting] = useState(false);
  // Patients who have stopped answering: the ones that need a call even though no alert says so.
  const silent = new Map(silentPatients(patients).map((x) => [x.patient.id, x.days]));
  return (
    <Card
      title={`Patients (${patients.length})`}
      action={
        <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setImporting(true)}>
          ⤓ Import from EHR
        </Button>
      }
    >
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
      <ul className="-mx-2 divide-y divide-slate-100">
        {sorted.map((p) => (
          <li key={p.id}>
            <Link to={`/patients/${p.id}`} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-slate-50">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{p.name}</div>
                <div className="text-xs text-slate-500">
                  {p.age != null ? `${p.age}y` : 'age unknown'} · {languageName(p.language)} · day {p.signals?.daysSinceDischarge ?? '—'}
                  {p.signals?.missedCheckins7d > 0 && <span className="text-amber-700"> · {p.signals.missedCheckins7d} missed</span>}
                  {silent.has(p.id) && <span className="font-medium text-red-700"> · silent {silent.get(p.id)}d</span>}
                </div>
              </div>
              {p.lastTier && <TierBadge tier={p.lastTier} />}
              <RiskBadge tier={p.riskTier} trend={p.riskDynamic?.trend} />
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
    setStatus({ kind: 'sending' });
    try {
      setStatus({ kind: 'done', ...messageOutcome(await api.message(patientId, text.trim())) });
      setText('');
    } catch (err) {
      setStatus({ kind: 'error', text: err.status === 404 ? 'Messaging is not available on this backend yet.' : err.message });
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
          <Button disabled={!patientId || !text.trim() || status?.kind === 'sending'}>Send</Button>
          {status && status.kind !== 'sending' && <span className={`text-xs ${status.tone === 'ok' ? 'text-emerald-700' : status.tone === 'warn' ? 'text-amber-700' : 'text-red-700'}`}>{status.text}</span>}
        </div>
      </form>
    </Card>
  );
}
