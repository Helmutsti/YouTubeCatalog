import { useState } from 'react';
import { setHidden, deleteVideoFile } from '../api/client.js';

// Nascondere un video (M25) — ma se il video è SCARICATO (M30) prima chiede
// "Vuoi tenere il video?": Sì → lo nasconde tenendo il file; No → cancella solo
// il file dal disco (download→none) e lo nasconde; la scheda resta comunque in
// libreria. Per i video non scaricati nasconde direttamente (niente file).
// Hook condiviso da tutte le pagine che nascondono un video, così la logica e il
// modale vivono in un solo posto. Ritorna { requestHide, modal }: la pagina
// chiama requestHide(video) e renderizza {modal}.
export function useHideWithPrompt({ onDone, onError } = {}) {
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);

  async function requestHide(video) {
    if (video.download !== 'downloaded') {
      try { await setHidden(video.id, true); onDone?.(); } catch (e) { onError?.(e.message); }
      return;
    }
    setPending(video);
  }

  async function resolve(keep) {
    const v = pending;
    setBusy(true);
    try {
      if (!keep) await deleteVideoFile(v.id); // cancella SOLO il file, download→none
      await setHidden(v.id, true);
      onDone?.();
    } catch (e) {
      onError?.(e.message);
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const modal = pending ? (
    <div className="modal-overlay" onClick={() => !busy && setPending(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Vuoi tenere il video?</h3>
        <p>
          "{pending.title ?? pending.id}" verrà nascosto. Vuoi <b>tenere</b> il file scaricato su disco,
          oppure <b>cancellarlo</b> per liberare spazio? La scheda resta comunque in libreria.
        </p>
        <div className="modal-actions">
          <button className="btn" disabled={busy} onClick={() => setPending(null)}>Annulla</button>
          <button className="btn btn-danger" disabled={busy} onClick={() => resolve(false)}>Cancella il file</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => resolve(true)}>Tieni il video</button>
        </div>
      </div>
    </div>
  ) : null;

  return { requestHide, modal };
}
