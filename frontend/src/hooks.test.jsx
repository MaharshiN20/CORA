import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// A tiny socket: .on/.off/.emit, no network.
const handlers = {};
vi.mock('./api.js', () => ({
  socket: {
    on: (ev, fn) => ((handlers[ev] ??= new Set()).add(fn)),
    off: (ev, fn) => handlers[ev]?.delete(fn),
  },
}));
const emit = (ev) => handlers[ev]?.forEach((fn) => fn());

const { useLive, useConnected } = await import('./hooks.js');

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k];
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

describe('useLive', () => {
  it('loads data, and reloads on a socket change event', async () => {
    const loader = vi.fn().mockResolvedValueOnce('one').mockResolvedValueOnce('two');
    const { result } = renderHook(() => useLive(loader));
    await waitFor(() => expect(result.current.data).toBe('one'));
    act(() => emit('change'));
    await waitFor(() => expect(result.current.data).toBe('two'), { timeout: 1500 });
  });

  it('a slow older response can never overwrite a newer one', async () => {
    const first = deferred();
    const second = deferred();
    const loader = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useLive(loader, [], { live: false }));
    act(() => {
      result.current.reload(); // a second request starts before the first returns
    });
    await act(async () => second.resolve('new'));
    await waitFor(() => expect(result.current.data).toBe('new'));
    await act(async () => first.resolve('stale'));
    expect(result.current.data).toBe('new');
  });

  it('keeps showing the last good data when a refresh fails, and exposes the error', async () => {
    const loader = vi.fn().mockResolvedValueOnce('good').mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useLive(loader, [], { live: false }));
    await waitFor(() => expect(result.current.data).toBe('good'));
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.data).toBe('good');
    expect(result.current.error.message).toBe('boom');
  });

  it('a later success clears the error', async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');
    const { result } = renderHook(() => useLive(loader, [], { live: false }));
    await waitFor(() => expect(result.current.error?.message).toBe('boom'));
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.data).toBe('ok');
  });

  it('reload() resolves after the data is set (callers can await it)', async () => {
    const loader = vi.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('b');
    const { result } = renderHook(() => useLive(loader, [], { live: false }));
    await waitFor(() => expect(result.current.data).toBe('a'));
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.data).toBe('b');
  });
});

describe('useConnected', () => {
  it('is true at first, false after a disconnect or connect_error, true again on connect', () => {
    const { result } = renderHook(() => useConnected());
    expect(result.current).toBe(true);
    act(() => emit('disconnect'));
    expect(result.current).toBe(false);
    act(() => emit('connect'));
    expect(result.current).toBe(true);
    act(() => emit('connect_error'));
    expect(result.current).toBe(false);
  });
});
