import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// No real socket / network in tests.
vi.mock('../api.js', () => ({ api: { updateAlert: vi.fn(), simulate: vi.fn() }, socket: { on() {}, off() {} } }));

const AlertCardModule = await import('./AlertCard.jsx');
const { default: AlertCard, SlaCountdown } = AlertCardModule;
const { adherenceGrid, auditSummary } = await import('../pages/Patient.jsx');

const T0 = Date.parse('2026-09-26T12:00:00Z');
const base = { id: 'a1', tier: 'RED', kind: 'triage', status: 'open', patientId: 'p1', ts: new Date(T0).toISOString(), dueBy: new Date(T0 + 15 * 60000).toISOString(), reasons: ['Chest pain'] };
const renderCard = (alert, update = vi.fn().mockResolvedValue({})) => {
  render(
    <MemoryRouter>
      <AlertCard alert={alert} patient={{ id: 'p1', name: 'Maria Garcia' }} now={T0} update={update} />
    </MemoryRouter>,
  );
  return update;
};

describe('AlertCard outcome flow', () => {
  it('acknowledges an open alert', async () => {
    const update = renderCard(base);
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('a1', { status: 'acknowledged', by: 'nurse' }));
  });

  it('marks an acknowledged alert contacted', async () => {
    const update = renderCard({ ...base, status: 'acknowledged' });
    fireEvent.click(screen.getByRole('button', { name: 'Mark contacted' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('a1', { status: 'contacted', by: 'nurse' }));
  });

  it('resolving needs an outcome, then sends it with the note', async () => {
    const update = renderCard({ ...base, status: 'contacted' });
    fireEvent.click(screen.getByRole('button', { name: 'Resolve…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(await screen.findByText(/Pick an outcome/)).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('ER visit avoided'));
    fireEvent.change(screen.getByPlaceholderText('Note (optional)'), { target: { value: 'extra furosemide' } });
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('a1', { status: 'resolved', outcome: 'ed_avoided', by: 'nurse', note: 'extra furosemide' }));
  });

  it('shows the API error instead of failing silently', async () => {
    renderCard(base, vi.fn().mockRejectedValue(new Error('PATCH /alerts/a1 -> 500')));
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    expect(await screen.findByText('PATCH /alerts/a1 -> 500')).toBeInTheDocument();
  });

  it('links to the patient and shows reasons + AI summary', () => {
    renderCard({ ...base, source: 'ai_review', ai: { nurseSummary: 'Slow weight creep.' } });
    expect(screen.getByRole('link', { name: 'Maria Garcia' })).toHaveAttribute('href', '/patients/p1');
    expect(screen.getByText('Chest pain')).toBeInTheDocument();
    expect(screen.getByText(/Slow weight creep/)).toBeInTheDocument();
    expect(screen.getByText('AI review')).toBeInTheDocument();
  });
});

describe('SlaCountdown', () => {
  it('shows time left, then overdue', () => {
    const { rerender } = render(<SlaCountdown alert={base} now={T0} />);
    expect(screen.getByTestId('sla')).toHaveTextContent('15m left');
    rerender(<SlaCountdown alert={base} now={T0 + 20 * 60000} />);
    expect(screen.getByTestId('sla')).toHaveTextContent('Overdue 5m');
    expect(screen.getByTestId('sla').className).toMatch(/bg-red-600/);
  });
  it('renders nothing once resolved', () => {
    const { container } = render(<SlaCountdown alert={{ ...base, status: 'resolved' }} now={T0} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('patient page helpers', () => {
  it('adherence grid: taken / missed / unanswered / none per med per day', () => {
    const end = Date.parse('2026-09-26T20:00:00Z');
    const doses = [
      { ts: '2026-09-26T08:00:00Z', med: 'Furosemide', taken: true },
      { ts: '2026-09-25T08:00:00Z', med: 'Furosemide', taken: false },
      { ts: '2026-09-25T08:00:00Z', med: 'Carvedilol' }, // reminder never answered
    ];
    const g = adherenceGrid(doses, [{ name: 'Furosemide' }, { name: 'Lisinopril' }], end, 3);
    expect(g.days).toEqual(['2026-09-24', '2026-09-25', '2026-09-26']);
    expect(g.rows).toEqual([
      { name: 'Furosemide', cells: ['none', 'missed', 'taken'] },
      { name: 'Lisinopril', cells: ['none', 'none', 'none'] },
      { name: 'Carvedilol', cells: ['none', 'unanswered', 'none'] },
    ]);
  });
  it('audit summaries read like sentences', () => {
    expect(auditSummary({ data: { tier: 'YELLOW', flags: [{ text: 'Weight up 2.7 lb in 24h' }] } })).toBe('YELLOW · Weight up 2.7 lb in 24h');
    expect(auditSummary({ data: { status: 'resolved', outcome: 'ed_avoided', note: 'ok' } })).toBe('resolved · outcome: ed_avoided · “ok”');
    expect(auditSummary({ data: { foo: 1 } })).toBe('foo: 1');
  });
});

describe('RED is unmistakable, and the card carries the vitals', () => {
  it('a RED SLA pill is red even with time left; YELLOW is amber', () => {
    const { rerender } = render(<SlaCountdown alert={base} now={T0} />);
    expect(screen.getByTestId('sla').className).toMatch(/bg-red-600/);
    rerender(<SlaCountdown alert={{ ...base, tier: 'YELLOW', dueBy: new Date(T0 + 4 * 3600000).toISOString() }} now={T0} />);
    expect(screen.getByTestId('sla').className).toMatch(/amber/);
  });

  it('shows weight, 24h change, change vs dry weight, phone and language on triage cards', () => {
    const { VitalsStrip } = AlertCardModule;
    const patient = { id: 'p1', name: 'Maria Garcia', language: 'es', contactPhone: '(404) 555-0101', dryWeightLb: 172, signals: { weightDelta24h: 4.9 }, weights: [172, 173, 174.1, 179].map((lb, i) => ({ ts: new Date(T0 - (3 - i) * 86400000).toISOString(), lb })) };
    render(<VitalsStrip patient={patient} tier="YELLOW" />);
    const strip = screen.getByTestId('vitals');
    expect(strip).toHaveTextContent('179 lb');
    expect(strip).toHaveTextContent('▲4.9 /24h');
    expect(strip).toHaveTextContent('▲7 vs dry');
    expect(screen.getByRole('link', { name: /555-0101/ })).toHaveAttribute('href', 'tel:4045550101');
  });

  it('no weights, no strip', () => {
    const { VitalsStrip } = AlertCardModule;
    const { container } = render(<VitalsStrip patient={{ id: 'p1', name: 'X' }} tier="RED" />);
    expect(container).toBeEmptyDOMElement();
  });
});
