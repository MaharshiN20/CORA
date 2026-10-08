// "Needs action now": overdue alerts and ones about to breach their deadline, RED first. A strip a
// whole room can read. Each chip jumps to its card.
import { dueSoon, formatDuration } from '../lib/worklist.js';

export default function Wallboard({ alerts, patientsById = {}, now, onJump }) {
  const { overdue, soon, count } = dueSoon(alerts, now);
  if (!count) return null;
  const chip = (a, late) => {
    const name = patientsById[a.patientId]?.name ?? a.patientId;
    const ms = Date.parse(a.dueBy) - now;
    return (
      <button
        key={a.id}
        onClick={() => onJump?.(a.id)}
        className={`rounded-full px-3 py-1 text-sm font-medium ring-1 ${late ? 'bg-red-600 text-white ring-red-700' : 'bg-amber-100 text-amber-900 ring-amber-300'}`}
      >
        {a.tier === 'RED' ? '🚨 ' : ''}
        {name}: {late ? `overdue ${formatDuration(ms)}` : `due in ${formatDuration(ms)}`}
      </button>
    );
  };
  return (
    <section aria-label="Needs action now" className="rounded-xl border border-red-200 bg-red-50/60 p-3">
      <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-red-800">
        Needs action now · {overdue.length} overdue · {soon.length} due soon
      </h3>
      <div className="flex flex-wrap gap-2">
        {overdue.map((a) => chip(a, true))}
        {soon.map((a) => chip(a, false))}
      </div>
    </section>
  );
}
