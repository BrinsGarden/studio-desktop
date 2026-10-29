import { useEffect, useState } from 'react';
import { store } from '../store';
import { clearAutosave, readAutosave, restoreAutosave, startAutosave, type AutosaveRecord } from '../autosave';

/** On startup: offer to bring back the last autosaved project (after a crash or closed tab). */
export default function Recovery() {
  const [rec, setRec] = useState<AutosaveRecord | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    readAutosave().then((r) => {
      if (r && !store.state.doc) setRec(r);
      else startAutosave();
    });
  }, []);
  if (!rec) return null;
  const when = new Date(rec.time);
  const sameDay = when.toDateString() === new Date().toDateString();
  const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const restore = async () => {
    setBusy(true);
    try {
      const doc = await restoreAutosave(rec);
      store.load(doc);
      store.set({ dirty: true });
      store.toast(`Recovered ${doc.name} — use File › Save to keep a copy on your computer`);
    } catch (e) {
      store.toast(`Couldn't recover: ${(e as Error).message}`);
    }
    setRec(null);
    startAutosave();
  };
  const discard = async () => {
    await clearAutosave();
    setRec(null);
    startAutosave();
  };
  return (
    <div className="modal-backdrop recovery-backdrop">
      <div className="modal recovery" role="dialog" aria-label="Recover work">
        <h2>Pick up where you left off?</h2>
        <p>
          <strong>{rec.name || 'Untitled'}</strong> — {rec.layerCount} layers, autosaved {sameDay ? `today at ${time}` : `${when.toLocaleDateString()} ${time}`}.
        </p>
        <div className="row recovery-actions">
          <button type="button" className="btn primary" onClick={restore} disabled={busy}>
            {busy ? 'Recovering…' : 'Recover it'}
          </button>
          <button type="button" className="btn" onClick={discard} disabled={busy}>
            Start fresh
          </button>
        </div>
      </div>
    </div>
  );
}
