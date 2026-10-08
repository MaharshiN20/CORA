// Nurse command center. Patients talk to the bot on Telegram/SMS; this is where the
// care team works the worklist, reads the "why" behind every alert, and shows impact.
import { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router';
import { api } from './api.js';
import { useConnected, useLive } from './hooks.js';
import { Pill } from './components/ui.jsx';
import Worklist from './pages/Worklist.jsx';
import Patient from './pages/Patient.jsx';
import Impact from './pages/Impact.jsx';
import Demo from './pages/Demo.jsx';
import Join from './pages/Join.jsx';

// Health (incl. the demo clock offset) is needed across pages for SLA countdowns.
const HealthContext = createContext(null);
export const useHealth = () => useContext(HealthContext);

const LLM_NAMES = { claude: 'Claude', gemini: 'Gemini', ollama: 'Ollama', lmstudio: 'LM Studio' };
export function llmLabel(llm) {
  if (!llm || llm.provider === 'none') return 'AI: rules only';
  const model = llm.provider === 'claude' || !llm.model ? '' : ` · ${llm.model.split(/[/:]/).find(Boolean)}`;
  return `AI: ${LLM_NAMES[llm.provider] ?? llm.provider}${model}`;
}

export function HealthStrip({ health }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Pill ok={health?.ok} label="API" />
      <Pill ok={health?.telegram} label="Telegram" />
      <Pill ok={health?.llm && health.llm.provider !== 'none'} label={llmLabel(health?.llm)} />
      {health?.demoOffsetMs > 0 && <Pill ok label={`Demo clock +${Math.round(health.demoOffsetMs / 3600000)}h`} />}
    </div>
  );
}

function useProjector() {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem('projector') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    document.documentElement.classList.toggle('projector', on);
    try {
      localStorage.setItem('projector', on ? '1' : '0');
    } catch {
      /* private mode: fine, just not remembered */
    }
  }, [on]);
  return [on, setOn];
}

const NAV = [
  ['/', 'Worklist'],
  ['/impact', 'Impact'],
  ['/demo', 'Demo'],
  ['/join', 'Join'],
];

export default function App() {
  // Polled as well as live: a backend restart shows up (and recovers) without a reload.
  const { data: health } = useLive(() => api.health().catch(() => ({ ok: false, offline: true })), [], { pollMs: 10000 });
  const [projector, setProjector] = useProjector();
  const connected = useConnected();
  const { pathname } = useLocation();
  const bare = pathname === '/join'; // full-screen QR wall for judges

  return (
    <HealthContext.Provider value={health}>
      <div className="min-h-screen bg-slate-50 text-slate-900">
        {!bare && (
          <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
            <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 projector:max-w-none projector:flex-nowrap projector:py-2">
              <h1 className="text-lg font-bold">
                💙 HeartBridge <span className="ml-1 text-sm font-normal text-slate-500">care team</span>
              </h1>
              <nav className="flex gap-1">
                {NAV.map(([to, label]) => (
                  <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `rounded-lg px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
                    {label}
                  </NavLink>
                ))}
              </nav>
              <div className="ml-auto flex items-center gap-3">
                <span className="projector:hidden">
                  <HealthStrip health={health} />
                </span>
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-600">
                  <input type="checkbox" checked={projector} onChange={(e) => setProjector(e.target.checked)} />
                  Projector mode
                </label>
              </div>
            </div>
          </header>
        )}
        {!bare && !connected && !health?.offline && (
          <div role="status" className="bg-amber-500 px-5 py-1.5 text-center text-sm font-medium text-amber-950">
            Live updates are paused (connection lost). Reconnecting… new alerts may not appear until it is back.
          </div>
        )}
        {!bare && health?.offline && (
          <div role="alert" className="bg-red-600 px-5 py-1.5 text-center text-sm font-medium text-white">
            Can't reach the HeartBridge server. Retrying… (the page will catch up by itself)
          </div>
        )}
        <main className={bare ? '' : 'mx-auto max-w-[1400px] px-5 py-5 projector:max-w-none'}>
          <Routes>
            <Route path="/" element={<Worklist />} />
            <Route path="/patients/:id" element={<Patient />} />
            <Route path="/impact" element={<Impact />} />
            <Route path="/demo" element={<Demo />} />
            <Route path="/join" element={<Join />} />
            <Route path="*" element={<p className="text-slate-500">Page not found.</p>} />
          </Routes>
        </main>
      </div>
    </HealthContext.Provider>
  );
}
