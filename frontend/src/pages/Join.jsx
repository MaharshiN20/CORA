// Full-screen QR wall for judges: "Scan to become a patient". One code per language.
import { Link } from 'react-router';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { languageName } from '../lib/format.js';
import Qr from '../components/Qr.jsx';

export default function Join() {
  const { data } = useLive(() => api.join().catch(() => ({ bot: null, links: [] })));
  return (
    <div className="flex min-h-screen flex-col items-center bg-gradient-to-b from-blue-700 to-blue-900 px-6 py-10 text-white">
      <h1 className="text-center text-4xl font-extrabold md:text-6xl">💙 Scan to become a patient</h1>
      <p className="mt-3 max-w-2xl text-center text-lg text-blue-100 md:text-xl">
        Pick your language, open Telegram, and do a heart-failure check-in. Your answers show up live on the nurse dashboard.
      </p>
      {!data ? null : !data.bot ? (
        <div className="mt-16 max-w-xl rounded-xl bg-white/10 p-6 text-center text-lg">
          <p>Telegram isn't set up on this server yet (TELEGRAM_BOT_USERNAME).</p>
          <p className="mt-3 text-base text-blue-100">You can still try the whole patient experience in the browser.</p>
          <Link to="/demo" className="mt-4 inline-block rounded-lg bg-white px-5 py-2 font-semibold text-blue-800">
            Open the phone simulator
          </Link>
        </div>
      ) : (
        <div className="mt-10 grid w-full max-w-6xl grid-cols-2 gap-6 md:grid-cols-3 lg:grid-cols-4">
          {data.links.map((l) => (
            <div key={l.language} className="flex flex-col items-center gap-3 rounded-2xl bg-white p-4 text-slate-900 shadow-xl">
              <Qr value={l.url} size={200} label={`Join in ${l.name}`} />
              <div className="text-center">
                <div className="text-xl font-bold">{l.nativeName ?? languageName(l.language)}</div>
                {l.name && l.name !== l.nativeName && <div className="text-sm text-slate-500">{l.name}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
      <Link to="/" className="mt-auto pt-10 text-sm text-blue-200 underline">
        Back to dashboard
      </Link>
    </div>
  );
}
