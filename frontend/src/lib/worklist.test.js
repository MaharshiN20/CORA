import { describe, it, expect } from 'vitest';
import { sortWorklist, filterWorklist, sla, formatDuration, nextAction, resolvePatch, kindOf, aiOf } from './worklist.js';

const T0 = Date.parse('2026-09-26T12:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const alert = (id, tier, dueMin, extra = {}) => ({ id, tier, dueBy: at(dueMin), ts: at(-10), status: 'open', patientId: 'p1', kind: 'triage', ...extra });

describe('sortWorklist', () => {
  it('orders by tier, then SLA deadline, then patient risk, then newest', () => {
    const patients = { p1: { riskScore: 5 }, p2: { riskScore: 12 } };
    const list = [
      alert('info', 'INFO', 5),
      alert('y-late', 'YELLOW', 200),
      alert('y-soon', 'YELLOW', 30),
      alert('red', 'RED', 15),
      alert('y-soon-highrisk', 'YELLOW', 30, { patientId: 'p2' }),
      alert('y-soon-newer', 'YELLOW', 30, { ts: at(-1) }),
    ];
    expect(sortWorklist(list, patients).map((a) => a.id)).toEqual(['red', 'y-soon-highrisk', 'y-soon-newer', 'y-soon', 'y-late', 'info']);
  });

  it('drops resolved items and puts items with no SLA last within their tier', () => {
    const list = [alert('done', 'RED', 1, { status: 'resolved' }), alert('nodue', 'YELLOW', 0, { dueBy: undefined }), alert('due', 'YELLOW', 500)];
    expect(sortWorklist(list).map((a) => a.id)).toEqual(['due', 'nodue']);
  });

  it('keeps acknowledged/contacted items (still on the list until resolved)', () => {
    const list = [alert('a', 'YELLOW', 10, { status: 'acknowledged' }), alert('c', 'RED', 10, { status: 'contacted' })];
    expect(sortWorklist(list).map((a) => a.id)).toEqual(['c', 'a']);
  });
});

describe('filterWorklist', () => {
  const list = [alert('1', 'RED', 1), alert('2', 'YELLOW', 1, { kind: 'refill' }), alert('3', 'INFO', 1, { kind: undefined })];
  it('filters by kind and tier; missing kind counts as triage', () => {
    expect(filterWorklist(list, { kind: 'triage' }).map((a) => a.id)).toEqual(['1', '3']);
    expect(filterWorklist(list, { tier: 'YELLOW' }).map((a) => a.id)).toEqual(['2']);
    expect(filterWorklist(list, { kind: 'refill', tier: 'RED' })).toEqual([]);
    expect(filterWorklist(list)).toHaveLength(3);
  });
  it('labels unknown kinds instead of crashing', () => {
    expect(kindOf({ kind: 'mystery' }).label).toBe('mystery');
    expect(kindOf({}).label).toBe('Triage');
  });
});

describe('SLA countdown', () => {
  it('formats durations', () => {
    expect(formatDuration(30_000)).toBe('<1m');
    expect(formatDuration(14 * 60000)).toBe('14m');
    expect(formatDuration(65 * 60000)).toBe('1h 05m');
    expect(formatDuration(26 * 3600000)).toBe('1d 2h');
  });
  it('counts down and flips to overdue', () => {
    const a = alert('x', 'RED', 15);
    expect(sla(a, T0)).toEqual({ remainingMs: 15 * 60000, overdue: false, label: '15m left' });
    expect(sla(a, T0 + 14.5 * 60000).label).toBe('<1m left');
    expect(sla(a, T0 + 18 * 60000)).toEqual({ remainingMs: -3 * 60000, overdue: true, label: 'Overdue 3m' });
  });
  it('is null for resolved items or items without a deadline', () => {
    expect(sla(alert('x', 'RED', 15, { status: 'resolved' }), T0)).toBeNull();
    expect(sla(alert('x', 'RED', 15, { dueBy: undefined }), T0)).toBeNull();
  });
});

describe('outcome flow', () => {
  it('walks open -> acknowledged -> contacted -> resolved', () => {
    expect(nextAction({ status: 'open' })).toEqual({ status: 'acknowledged', label: 'Acknowledge' });
    expect(nextAction({ status: 'acknowledged' }).status).toBe('contacted');
    expect(nextAction({ status: 'contacted' }).status).toBe('resolved');
    expect(nextAction({ status: 'resolved' })).toBeNull();
  });
  it('resolving requires a known outcome; note is trimmed and optional', () => {
    expect(resolvePatch('ed_avoided', '  called, extra furosemide  ')).toEqual({ status: 'resolved', outcome: 'ed_avoided', by: 'nurse', note: 'called, extra furosemide' });
    expect(resolvePatch('false_positive', '   ')).toEqual({ status: 'resolved', outcome: 'false_positive', by: 'nurse' });
    expect(() => resolvePatch(undefined)).toThrow(/outcome/);
    expect(() => resolvePatch('maybe')).toThrow(/outcome/);
  });
});

describe('aiOf', () => {
  it('reads the AI brief from the alert itself, as the API sends it', () => {
    const a = { nurseSummary: 'Slow creep.', suggestedActions: ['Call'], readmissionRisk: 'moderate', model: 'm' };
    expect(aiOf(a)).toEqual({ nurseSummary: 'Slow creep.', suggestedActions: ['Call'], readmissionRisk: 'moderate', model: 'm' });
  });
  it('is null for alerts without a brief (including a nested `ai` nobody sets)', () => {
    expect(aiOf({ tier: 'RED' })).toBeNull();
    expect(aiOf({ ai: { nurseSummary: 'x' } })).toBeNull();
    expect(aiOf(null)).toBeNull();
  });
  it('tolerates a missing action list', () => {
    expect(aiOf({ nurseSummary: 'x' }).suggestedActions).toEqual([]);
  });
});
