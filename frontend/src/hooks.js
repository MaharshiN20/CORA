import { useCallback, useEffect, useRef, useState } from 'react';
import { socket } from './api.js';

// Load data and reload it whenever the backend emits a socket.io `change` event.
// Refetches are coalesced (a burst of changes -> one reload) so a check-in that writes
// ten records doesn't cause ten requests.
export function useLive(loader, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const timer = useRef(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(() => loader().then((d) => (setData(d), setError(null))).catch(setError), deps);

  useEffect(() => {
    load();
    const onChange = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(load, 150);
    };
    socket.on('change', onChange);
    return () => {
      socket.off('change', onChange);
      clearTimeout(timer.current);
    };
  }, [load]);

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
