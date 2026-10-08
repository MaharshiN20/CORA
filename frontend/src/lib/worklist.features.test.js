import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sortWorklist, filterWorklist, dueSoon, silentPatients } from './worklist.js';
import { readNurse, saveNurse, nurseBy } from './nurse.js';
import { canNotify, notifyPermission, enableNotifications, notifyRed, titleFor } from './notify.js';

const T0 = Date.parse('2026-09-26T12:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const alert = (id, tier, dueMin, extra = {}) => ({ id, tier, dueBy: at(dueMin), ts: at(-10), status: 'open', patientId: 'p1', kind: 'triage', title: `title ${id}`, reasons: [], ...extra });
const patients = { p1: { id: 'p1', name: 'María García', riskScore: 5 }, p2: { id: 'p2', name: 'Robert Johnson', riskScore: 9 } };

describe('search', () => {
  const list = [
    alert('1', 'RED', 5, { title: 'Chest pain reported', patientId: 'p1' }),
    alert('2', 'YELLOW', 60, { title: 'Weight up 3 lb', patientId: 'p2', reasons: ['Weight up 3 lb in 24h'], assignee: 'Ana' }),
    alert('3', 'INFO', 600, { kind: 'refill', title: 'Furosemide not picked up', patientId: 'p2' }),
  ];
  const ids = (f) => filterWorklist(list, { patientsById: patients, ...f }).map((a) => a.id);

  it('matches patient name, title, reasons, assignee and kind, case- and accent-insensitively', () => {
    expect(ids({ q: 'maria garcia' })).toEqual(['1']);
    expect(ids({ q: 'ROBERT' })).toEqual(['2', '3']);
    expect(ids({ q: 'chest' })).toEqual(['1']);
    expect(ids({ q: '24h' })).toEqual(['2']);
    expect(ids({ q: 'ana' })).toEqual(['2']);
    expect(ids({ q: 'refill' })).toEqual(['3']);
  });
  it('every word must match somewhere ("robert weight" narrows)', () => {
    expect(ids({ q: 'robert weight' })).toEqual(['2']);
    expect(ids({ q: 'robert chest' })).toEqual([]);
  });
  it('an empty or whitespace query matches everything; works together with the other filters', () => {
    expect(ids({ q: '   ' })).toHaveLength(3);
    expect(ids({ q: 'robert', tier: 'INFO' })).toEqual(['3']);
  });
  it('tolerates alerts for patients we do not know', () => {
    expect(filterWorklist([alert('9', 'RED', 1, { patientId: 'ghost' })], { q: 'ghost', patientsById: patients })).toHaveLength(1);
  });
});

describe('status and assignee filters', () => {
  const list = [
    alert('a', 'RED', 1, { status: 'open' }),
    alert('b', 'RED', 1, { status: 'acknowledged', assignee: 'Ana' }),
    alert('c', 'YELLOW', 1, { status: 'contacted', assignee: 'ben' }),
  ];
  it('by status', () => {
    expect(filterWorklist(list, { status: 'open' }).map((a) => a.id)).toEqual(['a']);
    expect(filterWorklist(list, { status: 'contacted' }).map((a) => a.id)).toEqual(['c']);
  });
  it('"mine" is the signed-in nurse (case-insensitive); "unassigned" is nobody', () => {
    expect(filterWorklist(list, { assignee: 'mine', me: 'ANA' }).map((a) => a.id)).toEqual(['b']);
    expect(filterWorklist(list, { assignee: 'unassigned' }).map((a) => a.id)).toEqual(['a']);
    expect(filterWorklist(list, { assignee: 'mine', me: '' })).toEqual([]);
  });
});

describe('sort modes', () => {
  const list = [alert('old', 'INFO', 500, { ts: at(-100) }), alert('new', 'YELLOW', 300, { ts: at(-1) }), alert('red', 'RED', 15, { ts: at(-30) })];
  it('urgency is the default; newest / oldest / sla are alternatives', () => {
    expect(sortWorklist(list).map((a) => a.id)).toEqual(['red', 'new', 'old']);
    expect(sortWorklist(list, {}, 'newest').map((a) => a.id)).toEqual(['new', 'red', 'old']);
    expect(sortWorklist(list, {}, 'oldest').map((a) => a.id)).toEqual(['old', 'red', 'new']);
    expect(sortWorklist(list, {}, 'sla').map((a) => a.id)).toEqual(['red', 'new', 'old']);
    expect(sortWorklist(list, {}, 'nonsense').map((a) => a.id)).toEqual(['red', 'new', 'old']);
  });
});

describe('wallboard: what needs a nurse right now', () => {
  const list = [
    alert('late-yellow', 'YELLOW', -30),
    alert('late-red', 'RED', -5),
    alert('soon-red', 'RED', 4),
    alert('later', 'YELLOW', 120),
    alert('done', 'RED', -50, { status: 'resolved' }),
    alert('acked-late', 'RED', -9, { status: 'acknowledged' }),
  ];
  it('overdue and due-within-10-minutes, RED first, then most overdue; resolved ignored', () => {
    const w = dueSoon(list, T0);
    expect(w.overdue.map((a) => a.id)).toEqual(['acked-late', 'late-red', 'late-yellow']);
    expect(w.soon.map((a) => a.id)).toEqual(['soon-red']);
    expect(w.count).toBe(4);
  });
  it('the window is adjustable and an empty list is empty', () => {
    expect(dueSoon(list, T0, { soonMs: 3 * 3600_000 }).soon.map((a) => a.id)).toEqual(['soon-red', 'later']);
    expect(dueSoon([], T0)).toEqual({ overdue: [], soon: [], count: 0 });
  });
});

describe('silent patients', () => {
  it('lists patients who have gone quiet, longest first, ignoring unknown and recent', () => {
    const ps = [
      { id: 'a', name: 'A', signals: { silentDays: 2 } },
      { id: 'b', name: 'B', signals: { silentDays: 6 } },
      { id: 'c', name: 'C', signals: { silentDays: 1 } },
      { id: 'd', name: 'D', signals: { silentDays: null } },
      { id: 'e', name: 'E' },
    ];
    expect(silentPatients(ps).map((x) => [x.patient.id, x.days])).toEqual([['b', 6], ['a', 2]]);
    expect(silentPatients(ps, 5).map((x) => x.patient.id)).toEqual(['b']);
  });
});

describe('nurse identity', () => {
  beforeEach(() => localStorage.clear());
  it('remembers the name, trims and caps it, and falls back to "nurse"', () => {
    expect(readNurse()).toBe('');
    expect(nurseBy()).toBe('nurse');
    saveNurse('  Ana Lopez  ');
    expect(readNurse()).toBe('Ana Lopez');
    expect(nurseBy()).toBe('Ana Lopez');
    saveNurse('x'.repeat(100));
    expect(readNurse()).toHaveLength(40);
    saveNurse('');
    expect(nurseBy()).toBe('nurse');
  });
  it('survives storage being blocked', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readNurse()).toBe('');
    spy.mockRestore();
  });
});

describe('desktop notifications', () => {
  const realNotification = globalThis.Notification;
  afterEach(() => {
    globalThis.Notification = realNotification;
  });

  it('reports "unsupported" without the API and never throws', async () => {
    delete globalThis.Notification;
    expect(canNotify()).toBe(false);
    expect(notifyPermission()).toBe('unsupported');
    expect(await enableNotifications()).toBe('unsupported');
    expect(notifyRed({ id: 'a', title: 't' }, 'Maria')).toBeNull();
  });
  it('asks once, and only notifies when permission was granted', async () => {
    const made = [];
    class N {
      static permission = 'default';
      static requestPermission = vi.fn(async () => (N.permission = 'granted'));
      constructor(title, opts) {
        made.push({ title, opts });
      }
    }
    globalThis.Notification = N;
    expect(notifyRed({ id: 'a', title: 'x' }, 'Maria')).toBeNull();
    expect(await enableNotifications()).toBe('granted');
    notifyRed({ id: 'a1', title: 'Chest pain' }, 'Maria');
    expect(made).toEqual([{ title: '🚨 RED: Maria', opts: expect.objectContaining({ body: 'Chest pain', tag: 'a1', requireInteraction: true }) }]);
    await enableNotifications();
    expect(N.requestPermission).toHaveBeenCalledTimes(1);
  });
  it('a denied permission stays denied and stays quiet', async () => {
    globalThis.Notification = class {
      static permission = 'denied';
    };
    expect(await enableNotifications()).toBe('denied');
    expect(notifyRed({ id: 'a', title: 't' }, 'M')).toBeNull();
  });
  it('the tab title shows how many REDs are open', () => {
    expect(titleFor(0)).toBe('HeartBridge');
    expect(titleFor(3)).toBe('(3) 🚨 HeartBridge');
  });
});
