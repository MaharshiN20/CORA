import { useCallback, useEffect, useRef, useState } from 'react';
import { socket } from './api.js';

// Load data and keep it fresh.
//   live   (default true): reload on the backend's socket.io `change` events. Data that never
//          changes with patient activity (join links, scenario list) passes false, so one chat
//          reply no longer triggers a refetch of every panel on the page.
//   pollMs: also reload on a timer (health: so a backend restart is noticed without a click).
// Refetches are coalesced (a burst of changes -> one reload), and every hook reloads when the
// socket reconnects, so the dashboard recovers by itself after a backend blip.
export function useLive(loader, deps = [], { live = true, pollMs } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const timer = useRef(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(() => loader().then((d) => (setData(d), setError(null))).catch(setError), deps);

  useEffect(() => {
    load();
    const soon = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(load, 150);
    };
    if (live) socket.on('change', soon);
    socket.on('connect', soon);
    const poll = pollMs ? setInterval(load, pollMs) : null;
    return () => {
      if (live) socket.off('change', soon);
      socket.off('connect', soon);
      clearInterval(poll);
      clearTimeout(timer.current);
    };
  }, [load, live, pollMs]);

  return { data, error, reload: load };
}

// A clock that ticks every `ms` (for SLA countdowns). Accepts an offset so countdowns
// follow the demo clock rather than the wall clock.
export function useNow(ms = 1000, offsetMs = 0) {
  const [now, setNow] = useState(() => Date.now() + offsetMs);
  useEffect(() => {
    setNow(Date.now() + offsetMs);
    const t = setInterval(() => setNow(Date.now() + offsetMs), ms);
    return () => clearInterval(t);
  }, [ms, offsetMs]);
  return now;
}

// A value remembered per browser (e.g. the simulator's patient). Storage can be blocked
// (private mode, previews): then it simply isn't remembered.
export function useStored(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? initial : JSON.parse(v);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* not remembered, fine */
    }
  }, [key, value]);
  return [value, setValue];
}
