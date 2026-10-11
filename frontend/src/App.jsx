// Nurse command center. Patients talk to the bot on Telegram/SMS; this is where the
// care team works the worklist, reads the "why" behind every alert, and shows impact.
import { Suspense, createContext, lazy, useContext, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router';
import { api } from './api.js';
import { useConnected, useLive } from './hooks.js';
import { Pill } from './components/ui.jsx';
import NurseName from './components/NurseName.jsx';
import Worklist from './pages/Worklist.jsx';
// The worklist is the landing page and stays in the main bundle; the rest load on first visit
// (one 815 kB chunk before; audit 2026-10-11).
const Patient = lazy(() => import('./pages/Patient.jsx'));
const Impact = lazy(() => import('./pages/Impact.jsx'));
const Demo = lazy(() => import('./pages/Demo.jsx'));
const Join = lazy(() => import('./pages/Join.jsx'));

// Health (incl. the demo clock offset) is needed across pages for SLA countdowns.
const HealthContext = createContext(null);
export const useHealth = () => useContext(HealthContext);

const LLM_NAMES = { claude: 'Claude', gemini: 'Gemini', ollama: 'Ollama', lmstudio: 'LM Studio' };
export function llmLabel(llm) {
  if (!llm || llm.provider === 'none') return 'AI: rules only';
  const model = llm.provider === 'claude' || !llm.model ? '' : ` · ${llm.model.split(/[/:]/).find(Boolean)}`;
  return `AI: ${LLM_NAMES[llm.provider] ?? llm.provider}${model}`;
}

// One quiet pill in the header ("Live" or "1 issue"); the per-service chips (and the model name,
// which judges don't need to read) open on click.
export function HealthStrip({ health }) {
  const checks = [
    { ok: health?.ok, label: 'API' },
    { ok: health?.telegram, label: 'Telegram' },
    { ok: health?.llm && health.llm.provider !== 'none', label: llmLabel(health?.llm) },
  ];
  const down = checks.filter((c) => !c.ok).length;
  return (
    <div className="flex items-center gap-1.5">
      {health?.demoOffsetMs > 0 && <Pill ok label={`Demo clock +${Math.round(health.demoOffsetMs / 3600000)}h`} />}
      <details className="group relative">
        <summary className={`flex cursor-pointer list-none items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition [&::-webkit-details-marker]:hidden ${down ? 'bg-amber-50 text-amber-800 ring-amber-200' : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50'}`}>
          <span className="relative flex size-2">
            {!down && <span className="absolute inline-flex size-full rounded-full bg-emerald-400 opacity-60 motion-safe:animate-ping" />}
            <span className={`relative inline-flex size-2 rounded-full ${down ? 'bg-amber-500' : 'bg-emerald-500'}`} />
          </span>
          {down ? `${down} ${down === 1 ? 'issue' : 'issues'}` : 'Live'}
        </summary>
        <div className="absolute right-0 top-full z-20 mt-2 flex w-max flex-col items-start gap-1.5 rounded-xl bg-white p-3 shadow-xl shadow-slate-900/10 ring-1 ring-slate-200">
          {checks.map((c) => (
            <Pill key={c.label} ok={c.ok} label={c.label} />
          ))}
        </div>
      </details>
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
          <header className="sticky top-0 z-10 border-b border-slate-200/80 bg-white/85 shadow-[0_1px_0_rgb(15_23_42/0.02)] backdrop-blur-md">
            <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 projector:max-w-none projector:flex-nowrap projector:py-2">
              <h1 className="text-lg font-bold tracking-tight">
                💙 HeartBridge <span className="ml-1 text-sm font-normal text-slate-500">care team</span>
              </h1>
              <nav className="flex gap-1">
                {NAV.map(([to, label]) => (
                  <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `rounded-lg px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}>
                    {label}
                  </NavLink>
                ))}
              </nav>
              <div className="ml-auto flex items-center gap-3">
                <span className="projector:hidden">
                  <HealthStrip health={health} />
                </span>
                <span className="projector:hidden">
                  <NurseName />
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
          <Suspense fallback={<p className="text-slate-500">Loading…</p>}>
          <Routes>
            <Route path="/" element={<Worklist />} />
            <Route path="/patients/:id" element={<Patient />} />
            <Route path="/impact" element={<Impact />} />
            <Route path="/demo" element={<Demo />} />
            <Route path="/join" element={<Join />} />
            <Route path="*" element={<p className="text-slate-500">Page not found.</p>} />
          </Routes>
          </Suspense>
        </main>
      </div>
    </HealthContext.Provider>
  );
}
