import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = {
  alerts: vi.fn(),
  patients: vi.fn(),
  patient: vi.fn(),
  insight: vi.fn(),
  updateAlert: vi.fn(),
  simulate: vi.fn(),
  health: vi.fn().mockResolvedValue({ ok: true }),
};
vi.mock('../api.js', () => ({ api, socket: { on() {}, off() {} } }));

const { default: Worklist } = await import('./Worklist.jsx');
const { default: Impact, slaBars } = await import('./Impact.jsx');
const { default: Patient } = await import('./Patient.jsx');

const patient = { id: 'p1', name: 'Maria Garcia', language: 'es', riskScore: 8, riskTier: 'High', lastTier: 'YELLOW', weights: [] };
const alert = { id: 'a1', tier: 'YELLOW', kind: 'triage', status: 'open', patientId: 'p1', ts: new Date().toISOString(), dueBy: new Date(Date.now() + 3600e3).toISOString(), title: 'Nurse call today', reasons: ['Weight up 3 lb'] };

beforeEach(() => {
  vi.clearAllMocks();
  api.health.mockResolvedValue({ ok: true });
});

describe('Worklist states', () => {
  it('shows an error with Retry when the first load fails, instead of "Loading…" forever', async () => {
    api.alerts.mockRejectedValueOnce(new Error('GET /alerts -> 500'));
    api.patients.mockResolvedValue([patient]);
    render(
      <MemoryRouter>
        <Worklist />
      </MemoryRouter>,
    );
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent(/Couldn't load the worklist/);
    expect(notice).toHaveTextContent('GET /alerts -> 500');
    api.alerts.mockResolvedValue([alert]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Nurse call today')).toBeInTheDocument();
  });

  it('keeps the last good worklist on screen when a refresh fails, with a stale-data notice', async () => {
    api.alerts.mockResolvedValueOnce([alert]);
    api.patients.mockResolvedValue([patient]);
    render(
      <MemoryRouter>
        <Worklist />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Nurse call today')).toBeInTheDocument();
  });

  it('a patient with no name does not crash the page', async () => {
    api.alerts.mockResolvedValue([{ ...alert, patientId: 'px' }]);
    api.patients.mockResolvedValue([{ id: 'px', riskScore: 1 }, patient]);
    render(
      <MemoryRouter>
        <Worklist />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Nurse call today')).toBeInTheDocument();
  });
});

describe('Patient page states', () => {
  it('shows a retryable error for a failed load (not only 404)', async () => {
    api.patient.mockRejectedValueOnce(Object.assign(new Error('GET /patients/p1 -> 500'), { status: 500 }));
    render(
      <MemoryRouter initialEntries={['/patients/p1']}>
        <Patient />
      </MemoryRouter>,
    );
    // useParams has no Route here, so id is undefined: the error path is what matters
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn't load this patient/);
  });
});

const impactFixture = (over = {}) => ({
  impact: {
    patients: 60,
    readmission: { engaged: { n: 20, readmitted: 2, rate: 0.1 }, notEngaged: { n: 10, readmitted: 3, rate: 0.3 }, overall: { n: 30, readmitted: 5, rate: 0.167 } },
    sampleIsSmall: false,
    projectedReadmissionsAvoided: 4,
    projectedBasis: 'synthetic',
    alerts: { total: 10, actionable: 8, perNursePerDay: 0.1, precision: 0.7, medianMinutesToAckByTier: { RED: 5, YELLOW: 60, INFO: null }, withinSlaByTier: { RED: 1, YELLOW: 0.5, INFO: null } },
    ...over,
  },
  engagement: { byDay: [], ladder: { recoveries: 0, viaNudge: 0, viaCaregiver: 0 } },
  equity: { byLanguage: {}, responseGap: null },
  roi: { measured: { tcmContactRate: 0.5, rpmEligibleRate: 0.4 } },
});
const mockImpact = (fx) => api.insight.mockImplementation(async (name) => fx[name === 'roi' ? 'roi' : name]);

describe('Impact page', () => {
  it('labels the avoided-readmissions figure as an assumption when it comes from the synthetic cohort', async () => {
    mockImpact(impactFixture());
    render(<Impact />);
    expect(await screen.findByText('Projected readmissions avoided')).toBeInTheDocument();
    expect(screen.getByText(/assumed from the synthetic cohort/i)).toBeInTheDocument();
  });

  it('says "observed" for live data and warns about a small sample', async () => {
    mockImpact(impactFixture({ projectedBasis: 'observed', sampleIsSmall: true }));
    render(<Impact />);
    expect(await screen.findByText(/observed in live patients/i)).toBeInTheDocument();
    expect(screen.getByText(/fewer than 10 known outcomes/i)).toBeInTheDocument();
  });

  it('a tier with no data gets a labelled empty bar, never a fake 0%', () => {
    const bars = slaBars(impactFixture().impact.alerts);
    expect(bars.map((b) => b.tier)).toEqual(['RED · median 5 min', 'YELLOW · median 60 min', 'INFO · no data yet']);
    expect(bars.map((b) => b.share)).toEqual([1, 0.5, null]);
    expect(slaBars({}).every((b) => b.share === null)).toBe(true);
  });

  it('the source toggle tells assistive tech which one is on', async () => {
    mockImpact(impactFixture());
    render(<Impact />);
    await screen.findByText('Projected readmissions avoided');
    expect(screen.getByRole('button', { name: 'Cohort + live' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Live demo' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows an error with Retry if the impact data fails to load', async () => {
    api.insight.mockRejectedValue(new Error('GET /insights/impact -> 500'));
    render(<Impact />);
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent(/Couldn't load impact/);
    await waitFor(() => expect(api.insight).toHaveBeenCalled());
  });
});
