import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useParams } from 'react-router';

const api = { fhirInfo: vi.fn(), fhirSearch: vi.fn(), fhirPreview: vi.fn(), fhirImport: vi.fn() };
vi.mock('../api.js', () => ({ api, socket: { on() {}, off() {} } }));
const { default: ImportDialog } = await import('./ImportDialog.jsx');

const RESULTS = [
  { fhirId: 'hb-rosa-1', name: 'Rosa María Delgado', age: 78, language: 'es', importedAs: null },
  { fhirId: 'hb-ahmed-2', name: 'Ahmed Warsame', age: null, language: 'en', importedAs: 'p_old' },
];
const PREVIEW = {
  data: { name: 'Rosa María Delgado', age: 78, language: 'es', dryWeightLb: 173.1 },
  summary: { heartFailure: true, conditions: [{ flag: 'heartFailure', text: 'Heart failure' }], medications: ['Furosemide 40 mg (diuretic)'], warnings: [] },
};

function PatientPage() {
  return <p>patient page {useParams().id}</p>;
}
const onClose = vi.fn();
const renderDialog = () =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<ImportDialog onClose={onClose} />} />
        <Route path="/patients/:id" element={<PatientPage />} />
      </Routes>
    </MemoryRouter>,
  );

const search = async () => {
  fireEvent.change(screen.getByLabelText('Patient name'), { target: { value: 'delgado' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await screen.findByText('Rosa María Delgado');
};

beforeEach(() => {
  vi.clearAllMocks();
  api.fhirInfo.mockResolvedValue({ ok: true, base: 'https://fhir.hospital.example.org/r4', sandbox: false, available: true });
  api.fhirSearch.mockResolvedValue(RESULTS);
  api.fhirPreview.mockResolvedValue(PREVIEW);
});

describe('ImportDialog', () => {
  it('search -> preview -> enroll -> opens the new patient', async () => {
    api.fhirImport.mockResolvedValue({ patient: { id: 'p_new' } });
    renderDialog();
    await search();
    expect(api.fhirSearch).toHaveBeenCalledWith('delgado');
    expect(screen.getByText(/age unknown/)).toBeInTheDocument(); // Ahmed has no birth date
    expect(screen.getByText('already enrolled')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Rosa María Delgado'));
    expect(await screen.findByText('Furosemide 40 mg (diuretic)')).toBeInTheDocument();
    expect(screen.getByText('Heart failure')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enroll patient' }));

    expect(await screen.findByText('patient page p_new')).toBeInTheDocument();
    expect(api.fhirImport).toHaveBeenCalledWith('hb-rosa-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('an already-imported patient opens the existing record (409)', async () => {
    api.fhirImport.mockRejectedValue(Object.assign(new Error('Already imported'), { status: 409, body: { error: 'Already imported', patientId: 'p_old' } }));
    renderDialog();
    await search();
    fireEvent.click(screen.getByText('Ahmed Warsame'));
    fireEvent.click(await screen.findByRole('button', { name: 'Open enrolled patient' }));
    expect(await screen.findByText('patient page p_old')).toBeInTheDocument();
  });

  it('shows the server error when the EHR is down', async () => {
    api.fhirSearch.mockRejectedValue(Object.assign(new Error('EHR server unreachable (timed out)'), { status: 502, body: { error: 'EHR server unreachable (timed out)' } }));
    renderDialog();
    fireEvent.change(screen.getByLabelText('Patient name'), { target: { value: 'delgado' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('EHR server unreachable (timed out)')).toBeInTheDocument();
  });

  it('a child with no heart-failure diagnosis cannot be enrolled without a deliberate override', async () => {
    api.fhirPreview.mockResolvedValue({ data: { name: 'Rik Smithies', age: 4, language: 'en' }, summary: { heartFailure: false, conditions: [], medications: [], warnings: ['No heart-failure diagnosis found in the EHR'] } });
    api.fhirImport.mockResolvedValue({ patient: { id: 'p_kid' } });
    renderDialog();
    await search();
    fireEvent.click(screen.getByText('Rosa María Delgado'));
    const enroll = await screen.findByRole('button', { name: 'Enroll patient' });
    expect(enroll).toBeDisabled();
    expect(screen.getByText(/No heart-failure diagnosis · Age 4/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(enroll);
    expect(await screen.findByText('patient page p_kid')).toBeInTheDocument();
    expect(api.fhirImport).toHaveBeenCalledWith('hb-rosa-1', { override: true });
  });

  it('needs at least 2 characters to search', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Patient name'), { target: { value: 'd' } });
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
  });
});

// K16: which EHR the dialog talks to (GET /api/fhir).
describe('ImportDialog: sandbox banner', () => {
  it('shows a banner when searches go to the public test server', async () => {
    api.fhirInfo.mockResolvedValue({ ok: true, base: 'https://hapi.fhir.org/baseR4', sandbox: true, available: true });
    renderDialog();
    const banner = await screen.findByRole('note');
    expect(banner).toHaveTextContent('Demo EHR.');
    expect(banner).toHaveTextContent(/public HAPI test server/);
    expect(banner).toHaveTextContent(/never a real patient/);
    // it is a warning, not a block: searching still works
    await search();
    expect(api.fhirSearch).toHaveBeenCalledWith('delgado');
  });

  it('shows no banner for a hospital FHIR server', async () => {
    renderDialog();
    await waitFor(() => expect(api.fhirInfo).toHaveBeenCalled());
    await search();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByText(/Demo EHR/)).not.toBeInTheDocument();
  });

  it('when the server refuses the sandbox (production), it says why and search is disabled', async () => {
    api.fhirInfo.mockResolvedValue({ ok: true, base: 'https://hapi.fhir.org/baseR4', sandbox: true, available: false, error: 'EHR import is off: this server would send patient names to the public HAPI test server. Set FHIR_BASE_URL to your own FHIR server.' });
    renderDialog();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/^EHR import is off: .*Set FHIR_BASE_URL to your own FHIR server\.$/);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Patient name')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Patient name'), { target: { value: 'delgado' } });
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
    expect(api.fhirSearch).not.toHaveBeenCalled();
  });

  it('if the info request fails the dialog still works (the search reports real problems)', async () => {
    api.fhirInfo.mockRejectedValue(new Error('GET /fhir -> 500'));
    renderDialog();
    await search();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('ImportDialog: switched off with no reason given', () => {
  it('still says import is off', async () => {
    api.fhirInfo.mockResolvedValue({ ok: true, base: 'x', sandbox: true, available: false });
    renderDialog();
    expect(await screen.findByRole('alert')).toHaveTextContent('EHR import is switched off for this deployment.');
    expect(screen.getByLabelText('Patient name')).toBeDisabled();
  });
});
