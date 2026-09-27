// "Import from EHR": search a FHIR server by name, preview what we'd create, enroll.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api.js';
import { languageName } from '../lib/format.js';
import { Button } from './ui.jsx';

export default function ImportDialog({ onClose }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [results, setResults] = useState(null);
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e.body?.error ?? e.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const search = (e) => {
    e.preventDefault();
    if (name.trim().length < 2) return;
    setSelected(null);
    setPreview(null);
    run(async () => setResults(await api.fhirSearch(name.trim())));
  };

  const pick = (r) => {
    setSelected(r);
    setPreview(null);
    run(async () => setPreview(await api.fhirPreview(r.fhirId)));
  };

  const doImport = () =>
    run(async () => {
      try {
        const { patient } = await api.fhirImport(selected.fhirId);
        onClose();
        navigate(`/patients/${patient.id}`);
      } catch (e) {
        if (e.status === 409 && e.body?.patientId) {
          onClose();
          navigate(`/patients/${e.body.patientId}`);
          return;
        }
        throw e;
      }
    });

  return (
    <div className="fixed inset-0 z-20 grid place-items-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label="Import from EHR" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold">Import from EHR</h2>
          <button onClick={onClose} aria-label="Close" className="rounded px-2 text-xl text-slate-400 hover:text-slate-700">
            ×
          </button>
        </div>
        <p className="mb-3 text-sm text-slate-500">Search the hospital's FHIR server (HAPI R4 sandbox in the demo). Medications, diagnoses and weights come across; nothing is written back.</p>
        <form onSubmit={search} className="flex gap-2">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Patient name, e.g. Smith" aria-label="Patient name" className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
          <Button disabled={busy || name.trim().length < 2}>Search</Button>
        </form>

        {error && <p className="mt-3 rounded-md bg-red-50 p-2 text-sm text-red-800">{error}</p>}

        {results && (
          <ul className="mt-3 max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
            {results.length === 0 && <li className="p-3 text-sm text-slate-500">No patients found.</li>}
            {results.map((r) => (
              <li key={r.fhirId}>
                <button onClick={() => pick(r)} className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 ${selected?.fhirId === r.fhirId ? 'bg-blue-50' : ''}`}>
                  <span className="font-medium">{r.name ?? '(no name)'}</span>
                  <span className="text-slate-500">
                    {r.age != null ? `${r.age}y` : 'age unknown'} · {languageName(r.language)} · FHIR {r.fhirId}
                  </span>
                  {r.importedAs && <span className="ml-auto rounded bg-emerald-100 px-1.5 text-xs text-emerald-800">already enrolled</span>}
                </button>
              </li>
            ))}
          </ul>
        )}

        {selected && (
          <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm">
            {!preview ? (
              <p className="text-slate-500">{busy ? 'Reading the chart…' : 'Could not read this chart.'}</p>
            ) : (
              <>
                <div className="font-semibold">{preview.data.name}</div>
                <div className="text-slate-600">
                  {preview.data.age != null ? `${preview.data.age}y` : 'age unknown'} · {languageName(preview.data.language)}
                  {preview.data.dryWeightLb ? ` · last weight ${preview.data.dryWeightLb} lb` : ''}
                </div>
                <div className="mt-2">
                  <span className="text-xs uppercase text-slate-500">Diagnoses</span>
                  <div>{preview.summary.conditions.length ? preview.summary.conditions.map((c) => c.text).join(' · ') : '—'}</div>
                </div>
                <div className="mt-2">
                  <span className="text-xs uppercase text-slate-500">Active medications</span>
                  <div>{preview.summary.medications.length ? preview.summary.medications.join(' · ') : '—'}</div>
                </div>
                {preview.summary.warnings.length > 0 && (
                  <ul className="mt-2 list-disc pl-5 text-amber-800">
                    {preview.summary.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                )}
                <div className="mt-3 flex gap-2">
                  <Button onClick={doImport} disabled={busy}>
                    {selected.importedAs ? 'Open enrolled patient' : 'Enroll patient'}
                  </Button>
                  <Button variant="subtle" onClick={() => setSelected(null)}>
                    Back
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
