// Nurse / care-team dashboard. Patients talk to the bot on Telegram;
// this is where the care team sees risk, alerts and conversations.
import { useCallback, useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';
import { api, socket } from './api.js';

const TIER_ORDER = { RED: 0, YELLOW: 1, GREEN: 2 };

export default function App() {
  const [health, setHealth] = useState(null);
  const [patients, setPatients] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [selectedId, setSelectedId] = useState('p1');
  const [detail, setDetail] = useState(null);

  const refresh = useCallback(async () => {
    const [p, a] = await Promise.all([api.patients(), api.alerts()]);
    setPatients(p);
    setAlerts(a);
    if (selectedId) setDetail(await api.patient(selectedId));
  }, [selectedId]);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth({ ok: false }));
    refresh();
    socket.on('change', refresh);
    return () => socket.off('change', refresh);
  }, [refresh]);

  const openAlerts = alerts.filter((a) => a.status === 'open');

  return (
    <div className="app">
      <header>
        <h1>💙 HeartBridge <span>CHF post-discharge co-pilot</span></h1>
        <div className="status">
          <Pill ok={health?.ok} label="API" />
          <Pill ok={health?.telegram} label="Telegram" />
          <Pill ok={health?.claude} label="Claude" />
          <button className="ghost" onClick={() => api.reset()}>Reset demo</button>
        </div>
      </header>

      <main>
        <section className="col">
          <h2>Patients</h2>
          {patients.map((p) => (
            <div key={p.id} className={`card patient ${p.id === selectedId ? 'active' : ''}`} onClick={() => setSelectedId(p.id)}>
              <div className="row">
                <strong>{p.name}</strong>
                <span className={`tier ${p.riskTier ?? 'NA'}`}>{p.riskTier ?? 'risk —'}</span>
              </div>
              <small>
                {p.age}y · {p.language.toUpperCase()} · {p.chatId ? '📱 linked' : `code ${p.linkCode}`}
              </small>
            </div>
          ))}
        </section>

        <section className="col wide">{detail && <PatientDetail p={detail} />}</section>

        <section className="col">
          <h2>Alerts {openAlerts.length > 0 && <span className="badge">{openAlerts.length}</span>}</h2>
          {alerts.length === 0 && <p className="muted">No alerts yet.</p>}
          {alerts.map((a) => (
            <div key={a.id} className={`card alert ${a.tier} ${a.status}`}>
              <div className="row">
                <strong>{patients.find((p) => p.id === a.patientId)?.name}</strong>
                <span className={`tier ${a.tier}`}>{a.tier}</span>
              </div>
              <ul>{a.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              {a.status === 'open' && <button onClick={() => api.ackAlert(a.id)}>Acknowledge</button>}
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}

function PatientDetail({ p }) {
  const [draft, setDraft] = useState('');
  const weights = p.weights.map((w) => ({ day: new Date(w.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), lb: w.lb }));

  const send = async (e) => {
    e.preventDefault();
    if (!draft.trim()) return;
    await api.simulate(p.id, draft);
    setDraft('');
  };

  return (
    <>
      <div className="row">
        <h2>{p.name}</h2>
        <button onClick={() => api.startCheckin(p.id)}>▶ Start check-in</button>
      </div>
      <p className="muted">
        Discharged {new Date(p.dischargedAt).toLocaleDateString()} · Dry weight {p.dryWeightLb} lb · Caregiver: {p.caregiver.name} ({p.caregiver.relation})
      </p>

      <div className="card">
        <h3>Daily weight</h3>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={weights}>
            <XAxis dataKey="day" />
            <YAxis domain={['dataMin - 2', 'dataMax + 2']} />
            <Tooltip />
            <ReferenceLine y={p.dryWeightLb + 5} stroke="#e0a800" strokeDasharray="4 4" label="+5 lb" />
            <Line type="monotone" dataKey="lb" stroke="#2563eb" strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="card">
        <h3>Prescriptions</h3>
        {p.prescriptions.map((rx) => (
          <div key={rx.med} className="row">
            <span>{rx.med}</span>
            <span className={rx.pickedUpAt ? 'ok' : 'warn'}>{rx.pickedUpAt ? 'picked up' : '⚠ not picked up'}</span>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>Conversation</h3>
        <div className="chat">
          {p.messages.length === 0 && <p className="muted">No messages yet.</p>}
          {p.messages.map((m) => (
            <div key={m.id} className={`bubble ${m.direction} ${m.to}`}>
              {m.to === 'caregiver' && <em>→ caregiver: </em>}
              {m.text}
              {m.textEn && m.textEn !== m.text && <div className="en">EN: {m.textEn}</div>}
            </div>
          ))}
        </div>
        <form onSubmit={send} className="row">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Simulate a patient reply (no Telegram needed)" />
          <button>Send</button>
        </form>
      </div>
    </>
  );
}

const Pill = ({ ok, label }) => <span className={`pill ${ok ? 'on' : 'off'}`}>{label}</span>;
