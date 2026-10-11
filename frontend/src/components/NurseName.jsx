// "Signed in as": a name for the audit trail and for "assigned to me". Not a login.
import { useEffect, useState } from 'react';
import { useNurse } from '../hooks.js';

export default function NurseName() {
  const [name, setName] = useNurse();
  // The saved name is trimmed on every change; feeding that straight back into the input made it
  // impossible to type a space ("Nurse Kim" became "NurseKim"), so the box keeps what is typed and
  // shows the saved value again once the field loses focus or the name changes elsewhere.
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft((d) => (d.trim() === name ? d : name)), [name]);
  return (
    <label className="flex items-center gap-1.5 text-xs text-slate-600">
      <span className="whitespace-nowrap">Nurse</span>
      <input
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setName(e.target.value);
        }}
        onBlur={() => setDraft(name)}
        maxLength={40}
        placeholder="your name"
        aria-label="Your name (recorded on alerts you handle)"
        className="w-28 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
      />
    </label>
  );
}
