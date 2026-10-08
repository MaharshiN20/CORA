// "Signed in as": a name for the audit trail and for "assigned to me". Not a login.
import { useNurse } from '../hooks.js';

export default function NurseName() {
  const [name, setName] = useNurse();
  return (
    <label className="flex items-center gap-1.5 text-xs text-slate-600">
      <span className="whitespace-nowrap">Nurse</span>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={40}
        placeholder="your name"
        aria-label="Your name (recorded on alerts you handle)"
        className="w-28 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
      />
    </label>
  );
}
