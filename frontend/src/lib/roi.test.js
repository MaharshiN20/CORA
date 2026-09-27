import { describe, it, expect } from 'vitest';
import { roi } from './roi.js';
import { money, compactMoney, pct, minutes } from './format.js';

describe('ROI math (matches backend insights/metrics.js)', () => {
  it('defaults', () => {
    const r = roi();
    expect(r.readmissionsAvoided).toBe(51.3); // 1000 * 0.205 * 0.25 = 51.25
    expect(r.dollars).toEqual({
      readmissionCostAvoided: 768750,
      penaltyAvoided: 86250,
      tcmRevenue: 200960,
      rpmRevenue: 62400,
      total: 1118360,
    });
  });
  it('slider inputs arrive as strings; junk is ignored; penalty caps at 100%', () => {
    const r = roi({ discharges: '200', reduction: '2', costPerReadmit: '', bogus: 1 });
    expect(r.inputs.discharges).toBe(200);
    expect(r.inputs.costPerReadmit).toBe(15000);
    expect(r.inputs).not.toHaveProperty('bogus');
    expect(r.dollars.penaltyAvoided).toBe(345000);
  });
  it('zero discharges -> only the penalty term remains', () => {
    const r = roi({ discharges: 0 });
    expect(r.dollars.total).toBe(r.dollars.penaltyAvoided);
  });
});

describe('format', () => {
  it('renders null as a dash, never 0', () => {
    expect(money(null)).toBe('—');
    expect(pct(undefined)).toBe('—');
    expect(minutes(null)).toBe('—');
  });
  it('formats money, percents and minutes', () => {
    expect(money(1118360)).toBe('$1,118,360');
    expect(compactMoney(1118360)).toBe('$1.12M');
    expect(compactMoney(86250)).toBe('$86k');
    expect(pct(0.238)).toBe('24%');
    expect(pct(0.0069, 2)).toBe('0.69%');
    expect(minutes(13)).toBe('13 min');
    expect(minutes(144)).toBe('2.4 h');
  });
});
