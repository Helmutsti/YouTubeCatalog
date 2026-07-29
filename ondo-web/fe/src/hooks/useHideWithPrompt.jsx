import { useState } from 'react';
import { setHidden, deleteVideo } from '../api/client.js';

// Nascondere un video — ma se è SCARICATO prima chiede cosa fare del file:
// «Tieni il video» lo archivia lasciando il file dov'è; «Cancella tutto» lo toglie
// dalla libreria insieme al file. Per i video non scaricati archivia direttamente.
//
// Il core non sa cancellare *solo* il file lasciando la scheda in libreria — era la
// terza via dell'API originale — quindi la scelta è fra archiviare e cancellare
// davvero, e il modale lo dice invece di far finta.
//
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
      if (keep) {
        await setHidden(v.id, true);
      } else {
        // Via scheda e file insieme: non c'è modo di tenere l'una senza l'altro.
        await deleteVideo(v.id, true);
      }
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
          "{pending.title ?? pending.id}" verrà archiviato e sparirà dalla libreria, restando
          cercabile. Vuoi <b>tenere</b> il file su disco, oppure <b>cancellare tutto</b> —
          scheda e file — per liberare spazio?
        </p>
        <div className="modal-actions">
          <button className="btn" disabled={busy} onClick={() => setPending(null)}>Annulla</button>
          <button className="btn btn-danger" disabled={busy} onClick={() => resolve(false)}>Cancella tutto</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => resolve(true)}>Tieni il video</button>
        </div>
      </div>
    </div>
  ) : null;

  return { requestHide, modal };
}
