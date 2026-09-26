import { io } from 'socket.io-client';

export const socket = io();

async function req(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.json();
}

export const api = {
  health: () => req('GET', '/health'),
  patients: () => req('GET', '/patients'),
  patient: (id) => req('GET', `/patients/${id}`),
  alerts: () => req('GET', '/alerts'),
  ackAlert: (id) => req('PATCH', `/alerts/${id}`, { status: 'acknowledged' }),
  startCheckin: (id) => req('POST', `/patients/${id}/checkin`),
  simulate: (id, text) => req('POST', `/patients/${id}/simulate`, { text }),
  tap: (id, buttonData) => req('POST', `/patients/${id}/simulate`, { buttonData }),
  reset: () => req('POST', '/reset'),
};
