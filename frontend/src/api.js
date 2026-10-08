import { io } from 'socket.io-client';

// Access token for servers that set API_TOKEN. Kept in localStorage (asked for once, on the
// first 401); VITE_API_TOKEN pre-fills it for a single-clinic build. Open servers never ask.
const TOKEN_KEY = 'hb_token';
const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) || import.meta.env?.VITE_API_TOKEN || '';
  } catch {
    return import.meta.env?.VITE_API_TOKEN || '';
  }
};
const setToken = (t) => {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {}
  socket.auth = { token: t };
  if (socket.disconnected) socket.connect();
};

export const socket = io({ auth: (cb) => cb({ token: getToken() }) });

let asked = false;
async function req(method, path, body, retried = false) {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...(body && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !retried && !asked && typeof window !== 'undefined' && typeof window.prompt === 'function') {
    asked = true;
    const t = window.prompt('This HeartBridge server needs an access token:');
    asked = false;
    if (t) {
      setToken(t.trim());
      return req(method, path, body, true);
    }
  }
  if (!res.ok) {
    // Keep the JSON error body ({ error, ... }) so callers can show it or act on it.
    const body = await res.json().catch(() => null);
    const err = new Error(body?.error ?? `${method} ${path} -> ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.json();
}

const qs = (params) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')).toString();
  return s ? `?${s}` : '';
};

export const api = {
  health: () => req('GET', '/health'),
  languages: () => req('GET', '/languages'),
  patients: () => req('GET', '/patients'),
  patient: (id) => req('GET', `/patients/${id}`),
  alerts: () => req('GET', '/alerts'),
  updateAlert: (id, patch) => req('PATCH', `/alerts/${id}`, patch),
  applyProtocol: (alertId, by = 'Nurse') => req('POST', `/alerts/${alertId}/protocol`, { by }), // standing order (HF-02)
  startCheckin: (id) => req('POST', `/patients/${id}/checkin`),
  simulate: (id, body) => req('POST', `/patients/${id}/simulate`, body), // { text?, buttonData?, role? }
  message: (id, text) => req('POST', `/patients/${id}/message`, { text, from: 'Nurse' }), // -> { delivered, translated, language }
  template: (id, template, extra = {}) => req('POST', `/patients/${id}/message`, { template, from: 'Nurse', ...extra }), // 'ask_bp' | 'call_scheduled'
  pickedUp: (id, med) => req('POST', `/patients/${id}/prescriptions/${encodeURIComponent(med)}/picked-up`, { by: 'dashboard' }),
  join: () => req('GET', '/join'),
  // demo console
  clock: () => req('GET', '/demo/clock'),
  advance: (hours) => req('POST', '/demo/advance', { hours }),
  demoReset: () => req('POST', '/demo/reset'),
  scenarios: () => req('GET', '/demo/scenarios'),
  runScenario: (name) => req('POST', `/demo/scenario/${encodeURIComponent(name)}`),
  jobs: (params = {}) => req('GET', `/demo/jobs${qs(params)}`),
  // EHR import (M5)
  fhirSearch: (name) => req('GET', `/fhir/search${qs({ name })}`),
  fhirPreview: (fhirId) => req('GET', `/fhir/preview/${encodeURIComponent(fhirId)}`),
  fhirImport: (fhirPatientId, { override } = {}) => req('POST', '/fhir/import', { fhirPatientId, ...(override && { override: true }) }),
  fhirExport: (patientId) => req('GET', `/fhir/export/${encodeURIComponent(patientId)}`),
  // insights (M2)
  insight: (name, params = {}) => req('GET', `/insights/${name}${qs(params)}`),
};
