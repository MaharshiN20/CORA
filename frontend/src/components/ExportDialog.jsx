// "Export to EHR": the FHIR R4 Bundle HeartBridge would write back (weights, SpO2, BP, a
// triage Flag, a Task per open worklist item). A preview: nothing is sent.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Button } from './ui.jsx';

export const resourceCounts = (bundle) =>
  Object.entries((bundle?.entry ?? []).reduce((acc, e) => ((acc[e.resource.resourceType] = (acc[e.resource.resourceType] ?? 0) + 1), acc), {}));

export default function ExportDialog({ patient, onClose, load = api.fhirExport }) {
  const [bundle, setBundle] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    load(patient.id).then(setBundle, (e) => setError(e.message));
  }, [patient.id, load]);
  const json = bundle ? JSON.stringify(bundle, null, 2) : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
    } catch {
      setError('Copy failed: select the text instead.');
    }
  };
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label="Export to EHR" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-2xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-lg font-bold">Export to EHR: {patient.name}</h2>
          <span className="rounded bg-slate-100 px-1.5 text-xs text-slate-600">FHIR R4 · preview, not sent</span>
          <button onClick={onClose} aria-label="Close" className="ml-auto rounded px-2 text-xl text-slate-400 hover:text-slate-700">
            ×
          </button>
        </div>
        {error && <p className="rounded-md bg-red-50 p-2 text-sm text-red-800">{error}</p>}
        {!bundle && !error && <p className="text-sm text-slate-500">Building the bundle…</p>}
        {bundle && (
          <>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {resourceCounts(bundle).map(([type, n]) => (
                <span key={type} className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-800">
                  {n} × {type}
                </span>
              ))}
            </div>
            <pre className="min-h-0 flex-1 overflow-auto rounded-lg bg-slate-950 p-3 text-[11px] leading-snug text-emerald-200">{json}</pre>
            <div className="mt-3 flex gap-2">
              <Button onClick={copy}>{copied ? 'Copied ✓' : 'Copy JSON'}</Button>
              <Button variant="subtle" onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
