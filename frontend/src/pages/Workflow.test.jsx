import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = {
  alerts: vi.fn(),
  patients: vi.fn(),
  patient: vi.fn(),
  timeline: vi.fn(),
  riskHistory: vi.fn(),
  auditCsv: vi.fn(),
  updateAlert: vi.fn(),
  simulate: vi.fn(),
  jobs: vi.fn().mockResolvedValue([]),
  startCheckin: vi.fn(),
  health: vi.fn().mockResolvedValue({ ok: true }),
};
vi.mock('../api.js', () => ({ api, socket: { on() {}, off() {} } }));
const downloadText = vi.fn();
vi.mock('../lib/download.js', () => ({ downloadText }));

const { default: Worklist } = await import('./Worklist.jsx');
const { default: Patient } = await import('./Patient.jsx');
const { default: TimelineCard, describe: describeItem } = await import('../components/TimelineCard.jsx');
const { default: Wallboard } = await import('../components/Wallboard.jsx');
const { default: NurseName } = await import('../components/NurseName.jsx');
const { default: AlertCard } = await import('../components/AlertCard.jsx');

const NOW = Date.now();
const iso = (min) => new Date(NOW + min * 60000).toISOString();
const mk = (id, patientId, tier, dueMin, extra = {}) => ({ id, patientId, tier, kind: 'triage', status: 'open', ts: iso(-20), dueBy: iso(dueMin), title: `Title ${id}`, reasons: [`Reason ${id}`], ...extra });
const maria = { id: 'p1', name: 'Maria Garcia', language: 'es', riskScore: 8, riskTier: 'High', lastTier: 'RED', weights: [], signals: { silentDays: 4, daysSinceDischarge: 9 } };
const robert = { id: 'p2', name: 'Robert Johnson', language: 'en', riskScore: 3, riskTier: 'Low', lastTier: 'GREEN', weights: [], signals: { silentDays: 0 } };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.health.mockResolvedValue({ ok: true });
  api.jobs.mockResolvedValue([]);
  api.patients.mockResolvedValue([maria, robert]);
  api.alerts.mockResolvedValue([mk('a1', 'p1', 'RED', -5), mk('a2', 'p2', 'YELLOW', 120, { assignee: 'Ana', status: 'acknowledged' }), mk('a3', 'p2', 'INFO', 900, { kind: 'refill', title: 'Furosemide not picked up' })]);
});

const renderWorklist = () =>
  render(
    <MemoryRouter>
      <Worklist />
    </MemoryRouter>,
  );

describe('Worklist search, filters and sort', () => {
  it('searching narrows the list by patient name, and Clear filters brings it back', async () => {
    renderWorklist();
    await screen.findByText('Title a1');
    fireEvent.change(screen.getByLabelText('Search the worklist'), { target: { value: 'robert' } });
    expect(screen.queryByText('Title a1')).not.toBeInTheDocument();
    expect(screen.getByText('Title a2')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search the worklist'), { target: { value: 'zzz' } });
    expect(screen.getByText('Nothing matches these filters.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('Title a1')).toBeInTheDocument();
  });

  it('status and assignee filters work; "Mine" needs a name and uses it', async () => {
    renderWorklist();
    await screen.findByText('Title a1');
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'acknowledged' } });
    expect(screen.queryByText('Title a1')).not.toBeInTheDocument();
    expect(screen.getByText('Title a2')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Filter by assignee'), { target: { value: 'unassigned' } });
    expect(screen.queryByText('Title a2')).not.toBeInTheDocument();
    expect(screen.getByText('Title a1')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Mine \(set your name\)/ })).toBeDisabled();
  });

  it('"Mine" lists the alerts assigned to the signed-in nurse', async () => {
    localStorage.setItem('hb_nurse', 'Ana');
    renderWorklist();
    await screen.findByText('Title a1');
    fireEvent.change(screen.getByLabelText('Filter by assignee'), { target: { value: 'mine' } });
    expect(screen.getByText('Title a2')).toBeInTheDocument();
    expect(screen.queryByText('Title a1')).not.toBeInTheDocument();
  });

  it('sort by newest reorders the cards', async () => {
    api.alerts.mockResolvedValue([mk('old', 'p1', 'RED', 5, { ts: iso(-300) }), mk('new', 'p2', 'INFO', 600, { ts: iso(-1) })]);
    renderWorklist();
    await screen.findByText('Title old');
    const order = () => screen.getAllByRole('article').map((a) => a.id);
    expect(order()).toEqual(['alert-old', 'alert-new']);
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'newest' } });
    expect(order()).toEqual(['alert-new', 'alert-old']);
  });

  it('shows who has gone silent in the patient panel', async () => {
    renderWorklist();
    await screen.findByText('Title a1');
    expect(screen.getByText(/silent 4d/)).toBeInTheDocument();
  });

  it('the tab title carries the number of open RED alerts', async () => {
    renderWorklist();
    await screen.findByText('Title a1');
    await waitFor(() => expect(document.title).toBe('(1) 🚨 HeartBridge'));
  });

  it('the wallboard strip lists the overdue RED first', async () => {
    renderWorklist();
    const board = await screen.findByRole('region', { name: 'Needs action now' });
    expect(board).toHaveTextContent('Maria Garcia: overdue');
    expect(board).not.toHaveTextContent('Robert Johnson');
  });
});

describe('Wallboard', () => {
  it('renders nothing when nothing is due, and jumps to the card when a chip is clicked', () => {
    const { container, rerender } = render(<Wallboard alerts={[mk('x', 'p1', 'YELLOW', 600)]} now={NOW} />);
    expect(container).toBeEmptyDOMElement();
    const onJump = vi.fn();
    rerender(<Wallboard alerts={[mk('late', 'p1', 'RED', -3)]} patientsById={{ p1: maria }} now={NOW} onJump={onJump} />);
    fireEvent.click(screen.getByRole('button', { name: /Maria Garcia: overdue 3m/ }));
    expect(onJump).toHaveBeenCalledWith('late');
  });
});

describe('Nurse identity', () => {
  it('typing a name saves it; acknowledging records it as who did it and takes the alert', async () => {
    const update = vi.fn().mockResolvedValue({});
    render(
      <MemoryRouter>
        <NurseName />
        <AlertCard alert={mk('a9', 'p1', 'YELLOW', 60)} patient={maria} update={update} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText(/Your name/), { target: { value: 'Ana Lopez' } });
    expect(localStorage.getItem('hb_nurse')).toBe('Ana Lopez');
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('a9', { status: 'acknowledged', by: 'Ana Lopez', assignee: 'Ana Lopez' }));
  });

  it('does not steal an alert somebody already owns', async () => {
    localStorage.setItem('hb_nurse', 'Ben');
    const update = vi.fn().mockResolvedValue({});
    render(
      <MemoryRouter>
        <AlertCard alert={mk('a8', 'p1', 'YELLOW', 60, { assignee: 'Ana' })} patient={maria} update={update} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('a8', { status: 'acknowledged', by: 'Ben' }));
  });
});

const items = [
  { ts: iso(-1), kind: 'message', direction: 'in', from: 'patient', to: 'patient', text: 'me duele el pecho', textEn: 'my chest hurts' },
  { ts: iso(-2), kind: 'alert', alertId: 'a1', tier: 'RED', title: 'Possible emergency', status: 'open' },
  { ts: iso(-3), kind: 'checkin', tier: 'YELLOW', flags: ['Weight up 3 lb'], weight: 173, reporter: 'patient' },
  { ts: iso(-4), kind: 'reading', type: 'spo2', value: 92, source: 'device' },
  { ts: iso(-5), kind: 'event', type: 'nurse_action', summary: 'nurse action: status acknowledged' },
  { ts: iso(-6), kind: 'risk', score: 9, tier: 'High' },
];

describe('TimelineCard', () => {
  it('shows the patient\'s story, one readable line each, and hides risk rows by default', async () => {
    api.timeline.mockResolvedValue(items);
    render(<TimelineCard patientId="p1" />);
    expect(await screen.findByText(/my chest hurts/)).toBeInTheDocument();
    expect(screen.getByText(/Possible emergency · open/)).toBeInTheDocument();
    expect(screen.getByText(/YELLOW check-in · 173 lb · Weight up 3 lb/)).toBeInTheDocument();
    expect(screen.getByText(/spo2 92 \(device\)/)).toBeInTheDocument();
    expect(screen.getByText(/nurse action: status acknowledged/)).toBeInTheDocument();
    expect(screen.queryByText(/Risk 9 · High/)).not.toBeInTheDocument();
  });

  it('kind chips filter the list', async () => {
    api.timeline.mockResolvedValue(items);
    render(<TimelineCard patientId="p1" />);
    await screen.findByText(/my chest hurts/);
    fireEvent.click(screen.getByRole('button', { name: /Messages/ }));
    expect(screen.queryByText(/my chest hurts/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Risk/ }));
    expect(screen.getByText(/Risk 9 · High/)).toBeInTheDocument();
  });

  it('describe() marks messages that did not get delivered', () => {
    expect(describeItem({ kind: 'message', direction: 'out', to: 'patient', text: 'hi', delivery: 'queued' })).toMatch(/\[queued\]/);
    expect(describeItem({ kind: 'message', direction: 'out', to: 'patient', text: 'hi', delivery: 'sent' })).not.toMatch(/\[/);
  });

  it('a failed load shows an error with Retry', async () => {
    api.timeline.mockRejectedValueOnce(new Error('GET timeline -> 500'));
    render(<TimelineCard patientId="p1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn't load the timeline/);
    api.timeline.mockResolvedValue(items);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/my chest hurts/)).toBeInTheDocument();
  });
});

describe('Audit CSV', () => {
  it('the patient page downloads the audit CSV for that patient', async () => {
    api.patient.mockResolvedValue({ ...maria, messages: [], alerts: [], audit: [], readings: [], doses: [], meds: [], prescriptions: [], checkins: [], signals: {} });
    api.timeline.mockResolvedValue([]);
    api.riskHistory.mockResolvedValue([]);
    api.auditCsv.mockResolvedValue('ts,type\r\n');
    render(
      <MemoryRouter initialEntries={['/patients/p1']}>
        <Patient />
      </MemoryRouter>,
    );
    // no <Route>, so the id param is undefined; the button still builds the filename from the patient
    const btn = await screen.findByRole('button', { name: /Audit CSV/ });
    fireEvent.click(btn);
    await waitFor(() => expect(downloadText).toHaveBeenCalledWith('audit-p1.csv', 'ts,type\r\n'));
    expect(api.auditCsv).toHaveBeenCalledWith({ patientId: 'p1' });
  });
});
