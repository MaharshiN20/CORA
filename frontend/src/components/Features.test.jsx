import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../api.js', () => ({ api: {}, socket: { on() {}, off() {} } }));

const { default: ProtocolCard } = await import('./ProtocolCard.jsx');
const { TracePanes, latestTrace } = await import('./DebugDrawer.jsx');
const { resourceCounts } = await import('./ExportDialog.jsx');

const protocolCheck = (overrides = {}) => ({
  triggered: true,
  eligible: true,
  protocol: { id: 'HF-02', version: '2026-09-demo', title: 'Standing order: diuretic adjustment for fluid gain', authoredBy: 'Medical director (demo placeholder, unsigned)', demo: true, disclaimer: 'DEMO protocol. Not medical advice.' },
  checks: [
    { id: 'trigger', label: 'Trigger', status: 'pass', detail: 'Weight up 4.9 lb in 24h', required: true },
    { id: 'labs', label: 'Recent K⁺ / creatinine', status: 'pass', detail: 'K⁺ 4.6 · Cr 1.4', required: true },
    { id: 'bp', label: 'Systolic BP', status: 'unknown', detail: 'Not reported today', required: false, action: 'ask_bp' },
  ],
  ...overrides,
});
const alert = (check) => ({ id: 'a1', patientId: 'p1', tier: 'YELLOW', status: 'open', protocolCheck: check });

describe('ProtocolCard', () => {
  it('shows whose protocol it is and every check', () => {
    render(<ProtocolCard alert={alert(protocolCheck())} />);
    expect(screen.getByText(/Standing order HF-02/)).toBeInTheDocument();
    expect(screen.getByText('Demo protocol')).toBeInTheDocument();
    expect(screen.getByText(/Medical director/)).toBeInTheDocument();
    expect(screen.getByText(/K⁺ 4.6/)).toBeInTheDocument();
    expect(screen.getByText(/never from AI/)).toBeInTheDocument();
  });

  it('apply waits out the undo window; Undo cancels it', async () => {
    const apply = vi.fn().mockResolvedValue({ alert: { protocol: { by: 'Nurse', appliedAt: '2026-09-27T12:00:00Z' } }, fhir: { medicationRequest: { resourceType: 'MedicationRequest' } }, message: { textEn: 'take ONE extra dose' } });
    render(<ProtocolCard alert={alert(protocolCheck())} apply={apply} undoMs={250} />);
    fireEvent.click(screen.getByRole('button', { name: /Apply protocol/ }));
    expect(screen.getByText(/Applying HF-02 in/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Undo/ }));
    await act(() => new Promise((r) => setTimeout(r, 400)));
    expect(apply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Apply protocol/ }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith('a1'), { timeout: 2000 });
    expect(await screen.findByText(/Applied by Nurse/)).toBeInTheDocument();
    expect(screen.getByText(/MedicationRequest \+ CommunicationRequest/)).toBeInTheDocument();
  });

  it('not eligible: apply is disabled', () => {
    render(<ProtocolCard alert={alert(protocolCheck({ eligible: false }))} />);
    expect(screen.getByRole('button', { name: /Apply protocol/ })).toBeDisabled();
  });

  it('"Ask patient for BP" sends the template to the patient', async () => {
    const askBp = vi.fn().mockResolvedValue({});
    render(<ProtocolCard alert={alert(protocolCheck())} askBp={askBp} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask patient for BP' }));
    await waitFor(() => expect(askBp).toHaveBeenCalledWith('p1'));
  });
});

describe('Debug drawer', () => {
  const trace = {
    type: 'parse_trace',
    data: {
      text: 'nah slept fine on my usual 2 pillows',
      step: 'orthopnea',
      rules: { orthopnea: false },
      llm: { fields: { weightLb: { value: 200, evidence: '2000' } }, dropped: [{ field: 'weightLb', value: 200, reason: 'number does not match the quoted text' }], unverified: [], timedOut: false, ms: 812 },
      outcome: { tier: 'GREEN', flags: [] },
    },
  };
  it('picks the latest trace', () => {
    expect(latestTrace([{ type: 'x' }, trace, { type: 'triage' }])).toBe(trace);
    expect(latestTrace([])).toBeNull();
  });
  it('shows raw text, the AI extraction with what was dropped, and the rules outcome', () => {
    render(<TracePanes trace={trace} />);
    expect(screen.getByText('“nah slept fine on my usual 2 pillows”')).toBeInTheDocument();
    expect(screen.getByText(/dropped weightLb=200: number does not match/)).toBeInTheDocument();
    expect(screen.getByText('GREEN')).toBeInTheDocument();
    expect(screen.getByText(/no rule fired/)).toBeInTheDocument();
  });
  it('says so when the AI was not needed or timed out', () => {
    const { rerender } = render(<TracePanes trace={{ data: { button: 'ci:rf:none', step: 'redflags', rules: { redflagsAsked: true }, llm: null } }} />);
    expect(screen.getByText(/a button tap needs no AI/)).toBeInTheDocument();
    rerender(<TracePanes trace={{ data: { text: 'x', step: 'weight', rules: {}, llm: { timedOut: true, ms: 4001 } } }} />);
    expect(screen.getByText(/Timed out after 4001 ms/)).toBeInTheDocument();
  });
});

describe('FHIR export', () => {
  it('counts resources by type', () => {
    const b = { entry: [{ resource: { resourceType: 'Observation' } }, { resource: { resourceType: 'Observation' } }, { resource: { resourceType: 'Flag' } }] };
    expect(resourceCounts(b)).toEqual([
      ['Observation', 2],
      ['Flag', 1],
    ]);
  });
});
