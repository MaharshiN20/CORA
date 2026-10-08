// Who is at the keyboard. Kept in this browser only (localStorage), so every action in the audit
// trail says who did it instead of a generic "nurse". It is a label, not a login: real identity
// comes with API_TOKEN / SSO in production.
const KEY = 'hb_nurse';
const MAX = 40;

export function readNurse() {
  try {
    return (localStorage.getItem(KEY) ?? '').slice(0, MAX);
  } catch {
    return '';
  }
}

export function saveNurse(name) {
  const clean = String(name ?? '').trim().slice(0, MAX);
  try {
    if (clean) localStorage.setItem(KEY, clean);
    else localStorage.removeItem(KEY);
  } catch {
    /* blocked storage: the name just isn't remembered */
  }
  return clean;
}

// The `by` for PATCH /alerts and messages.
export const nurseBy = () => readNurse() || 'nurse';
