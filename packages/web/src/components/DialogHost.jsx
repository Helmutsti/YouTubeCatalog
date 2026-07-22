import { useEffect, useState } from 'react';
import { registerDialogHost } from '../lib/dialog.js';

// Renderizza il modale alert/confirm attivo (se presente), stesso markup di
// "Vuoi tenere il video?" (useHideWithPrompt) — montato una sola volta in
// Layout così è disponibile ovunque tramite confirmDialog()/alertDialog().
export function DialogHost() {
  const [state, setState] = useState(null);

  useEffect(() => {
    registerDialogHost(setState);
    return () => registerDialogHost(null);
  }, []);

  if (!state) return null;

  const isConfirm = state.type === 'confirm';

  function close(result) {
    state.resolve(result);
    setState(null);
  }

  return (
    <div className="modal-overlay" onClick={() => close(isConfirm ? false : undefined)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{state.title}</h3>
        <p>{state.message}</p>
        <div className="modal-actions">
          {isConfirm && <button className="btn" onClick={() => close(false)}>{state.cancelLabel}</button>}
          <button
            className={`btn ${isConfirm && state.danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => close(isConfirm ? true : undefined)}
          >
            {isConfirm ? state.confirmLabel : state.okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
