// Nurse / care-team dashboard. Patients talk to the bot on Telegram;
// this is where the care team sees risk, alerts and conversations.
import { useCallback, useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';
import { api, socket } from './api.js';

const TIER_ORDER = { RED: 0, YELLOW: 1, GREEN: 2 };

export default function App() {
  const [health, setHealth] = useState(null);
  const [patients, setPatients] = useState([]);
  const sortedPatients = [...patients].sort(
    (a, b) => (TIER_ORDER[a.lastTier] ?? 3) - (TIER_ORDER[b.lastTier] ?? 3) || b.riskScore - a.riskScore,
  );
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
    const loadHealth = () => api.health().then(setHealth).catch(() => setHealth({ ok: false }));
    loadHealth();
    const timer = setInterval(loadHealth, 30_000);
    refresh();
    socket.on('change', refresh);
    return () => {
      socket.off('change', refresh);
      clearInterval(timer);
    };
  }, [refresh]);

  const openAlerts = alerts.filter((a) => a.status === 'open');

  return (
    <div className="app">
      <header>
        <h1>💙 HeartBridge <span>CHF post-discharge co-pilot</span></h1>
        <div className="status">
          <Pill ok={health?.ok} label="API" />
          <Pill ok={health?.telegram} label="Telegram" />
          <Pill ok={health?.llm && health.llm.provider !== 'none'} label={llmLabel(health?.llm)} />
          <button className="ghost" onClick={() => api.reset()}>Reset demo</button>
        </div>
      </header>

      <main>
        <section className="col">
          <h2>Patients</h2>
          {sortedPatients.map((p) => (
            <div key={p.id} className={`card patient ${p.id === selectedId ? 'active' : ''}`} onClick={() => setSelectedId(p.id)}>
              <div className="row">
                <strong>{p.name}</strong>
                <span>
                  {p.lastTier && <span className={`tier ${p.lastTier}`}>{p.lastTier}</span>}{' '}
                  <span className={`tier ${p.riskTier}`}>{p.riskTier} risk</span>
                </span>
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
  const lastPatientMsg = p.messages.findLastIndex((m) => m.to === 'patient');
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
        <h3>Readmission risk: {p.riskTier} ({p.riskScore} pts)</h3>
        <div className="factors">
          {p.riskFactors?.map((f) => (
            <span key={f.label} className="factor">{f.label} +{f.points}</span>
          ))}
        </div>
      </div>

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
          {p.messages.map((m, i) => (
            <div key={m.id} className={`bubble ${m.direction} ${m.to}`}>
              {m.to === 'caregiver' && <em>→ caregiver: </em>}
              {m.text}
              {m.textEn && m.textEn !== m.text && <div className="en">EN: {m.textEn}</div>}
              {/* Only the latest patient message's buttons are tappable, like in Telegram. */}
              {m.buttons && i === lastPatientMsg && (
                <div className="chips">
                  {m.buttons.flat().map((b) => (
                    <button key={b.data} className="chip" onClick={() => api.tap(p.id, b.data)}>{b.label}</button>
                  ))}
                </div>
              )}
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

const LLM_NAMES = { claude: 'Claude', ollama: 'Ollama', lmstudio: 'LM Studio' };
function llmLabel(llm) {
  if (!llm || llm.provider === 'none') return 'AI: rules only';
  const model = llm.provider === 'claude' ? '' : ` · ${llm.model.split(/[/:]/).find(Boolean)}`;
  return `AI: ${LLM_NAMES[llm.provider]}${model}`;
}

const Pill = ({ ok, label }) => <span className={`pill ${ok ? 'on' : 'off'}`}>{label}</span>;
