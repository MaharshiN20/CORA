// Demo console: scripted scenarios, demo clock controls, QR codes to join, and a phone simulator.
import { useState } from 'react';
import { api } from '../api.js';
import { useLive, useStored } from '../hooks.js';
import { languageName, timeOf } from '../lib/format.js';
import { Card, Empty, Button } from '../components/ui.jsx';
import PhoneSimulator from '../components/PhoneSimulator.jsx';
import Qr from '../components/Qr.jsx';

const STEPS = [
  ['+6h', 6],
  ['+1 day', 24],
  ['+3 days', 72],
];

const SCENARIO_TONE = {
  GREEN: 'border-emerald-200 hover:border-emerald-400 hover:bg-emerald-50',
  YELLOW: 'border-amber-200 hover:border-amber-400 hover:bg-amber-50',
  RED: 'border-red-200 hover:border-red-400 hover:bg-red-50',
  SILENT: 'border-slate-200 hover:border-slate-400 hover:bg-slate-50',
};

export default function Demo() {
  const { data: join } = useLive(() => api.join().catch(() => ({ bot: null, links: [] })), [], { live: false });
  const { data: clock, reload: reloadClock } = useLive(() => api.clock());
  const { data: scenarios } = useLive(() => api.scenarios().catch(() => []), [], { live: false });
  const { data: patients } = useLive(() => api.patients());
  const [simId, setSimId] = useStored('demo.simulatorPatient', null);
  const [lastRun, setLastRun] = useState(null);
  const [busy, setBusy] = useState(false);

  const act = async (fn) => {
    setBusy(true);
    try {
      setLastRun(await fn());
      reloadClock();
    } catch (e) {
      setLastRun({ error: e.message });
    } finally {
      setBusy(false);
    }
  };

  // A scenario plays in the background; point the simulator at its patient to watch it.
  const play = (s) =>
    act(async () => {
      setSimId(s.patientId);
      const r = await api.runScenario(s.name);
      return { scenario: s, ...r };
    });

  const simPatientId = patients?.some((p) => p.id === simId) ? simId : patients?.[0]?.id;

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Demo console</h2>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_28rem]">
        <div className="space-y-4">
          <Card title="Scenarios (one click plays a whole conversation)">
            {!scenarios?.length ? (
              <Empty>No scenarios available on this server.</Empty>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {scenarios.map((s) => (
                  <button key={s.name} disabled={busy} onClick={() => play(s)} className={`rounded-lg border p-3 text-left transition disabled:opacity-50 ${SCENARIO_TONE[s.tier] ?? SCENARIO_TONE.SILENT}`}>
                    <div className="font-semibold">{s.title ?? s.name}</div>
                    {s.description && <div className="mt-0.5 text-sm text-slate-600">{s.description}</div>}
                  </button>
                ))}
              </div>
            )}
            {lastRun?.scenario && (
              <p className="mt-2 text-sm text-slate-600">
                ▶ Playing <b>{lastRun.scenario.title}</b> in the phone simulator ({lastRun.steps} steps)…
              </p>
            )}
          </Card>

          <Card title="Demo clock">
            <div className="flex flex-wrap items-center gap-3">
              <div>
                <div className="text-2xl font-bold tabular-nums">{clock ? timeOf(clock.now) : '—'}</div>
                <div className="text-xs text-slate-500">{clock?.offsetMs ? `${Math.round(clock.offsetMs / 3600000)} h ahead of real time` : 'real time'}</div>
              </div>
              <div className="ml-auto flex flex-wrap gap-2">
                {STEPS.map(([label, hours]) => (
                  <Button key={hours} disabled={busy} onClick={() => act(() => api.advance(hours))}>
                    {label}
                  </Button>
                ))}
                <Button variant="danger" disabled={busy} onClick={() => act(() => api.demoReset())}>
                  Reset demo
                </Button>
              </div>
            </div>
            {lastRun?.jobs && (
              <p className="mt-2 text-sm text-slate-600">
                Ran {lastRun.jobs.ran?.length ?? lastRun.jobs.ran ?? 0} jobs · {lastRun.jobs.missed?.length ?? lastRun.jobs.missed ?? 0} missed · {lastRun.jobs.failed?.length ?? lastRun.jobs.failed ?? 0} failed
              </p>
            )}
            {lastRun?.error && <p className="mt-2 text-sm text-red-700">{lastRun.error}</p>}
          </Card>

          <Card title="Join as a patient (scan with your phone)">
            {!join?.bot ? (
              <Empty>Telegram isn't configured (set TELEGRAM_BOT_USERNAME). Use the phone simulator instead.</Empty>
            ) : (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
                {join.links.map((l) => (
                  <a key={l.language} href={l.url} target="_blank" rel="noreferrer" className="flex flex-col items-center gap-1 rounded-lg p-2 hover:bg-slate-50">
                    <Qr value={l.url} size={130} label={`Join in ${l.name}`} />
                    <span className="text-sm font-medium">{l.nativeName ?? languageName(l.language)}</span>
                  </a>
                ))}
              </div>
            )}
          </Card>
        </div>

        <Card title="Phone simulator">
          {patients?.length ? <SimulatorPicker patients={patients} id={simPatientId} onPick={setSimId} /> : <Empty>No patients.</Empty>}
        </Card>
      </div>
    </div>
  );
}

function SimulatorPicker({ patients, id, onPick }) {
  const [role, setRole] = useState('patient');
  const [error, setError] = useState(null);
  const { data: p } = useLive(() => api.patient(id), [id]);
  const startCheckin = async () => {
    setError(null);
    try {
      await api.startCheckin(id);
    } catch (e) {
      setError(e.message);
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <select aria-label="Patient" value={id} onChange={(e) => onPick(e.target.value)} className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm">
          {patients.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name} · {languageName(x.language)}
            </option>
          ))}
        </select>
        <Button variant="ghost" onClick={startCheckin}>
          ▶ Check-in
        </Button>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {p && p.id === id ? <PhoneSimulator patient={p} messages={p.messages ?? []} role={role} onRoleChange={setRole} compact /> : <Empty>Loading…</Empty>}
    </div>
  );
}
