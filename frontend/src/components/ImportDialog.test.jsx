import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useParams } from 'react-router';

const api = { fhirSearch: vi.fn(), fhirPreview: vi.fn(), fhirImport: vi.fn() };
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
