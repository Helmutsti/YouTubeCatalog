import { useEffect, useState } from 'react';
import { registerDialogHost } from '../lib/dialog.js';

// Renderizza il modale alert/confirm attivo (se presente), stesso markup di
// "Vuoi tenere il video?" (useHideWithPrompt) — montato una sola volta in
// Layout così è disponibile ovunque tramite confirmDialog()/alertDialog().
export function DialogHost() {
  const [state, setState] = useState(null);
  // Selezione corrente del dialog a radio button (M56): resettata all'apertura
  // di ogni nuovo dialog di tipo 'radio' sul suo defaultValue.
  const [radioSel, setRadioSel] = useState(null);

  useEffect(() => {
    registerDialogHost(setState);
    return () => registerDialogHost(null);
  }, []);

  useEffect(() => {
    if (state?.type === 'radio') setRadioSel(state.defaultValue ?? state.options?.[0]?.value ?? null);
  }, [state]);

  if (!state) return null;

  const isConfirm = state.type === 'confirm';
  const isChoice = state.type === 'choice';
  const isRadio = state.type === 'radio';
  // Valore "annullato" per tipo (click fuori dal modale o pulsante Annulla).
  const cancelValue = isConfirm ? false : (isChoice || isRadio) ? null : undefined;

  function close(result) {
    state.resolve(result);
    setState(null);
  }

  // Scelta singola a radio button + conferma (M56, es. risoluzione di download).
  if (isRadio) {
    return (
      <div className="modal-overlay" onClick={() => close(null)}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3>{state.title}</h3>
          {state.message && <p>{state.message}</p>}
          <div className="modal-radios">
            {state.options.map((opt) => (
              <label key={String(opt.value)} className={`radio-row${radioSel === opt.value ? ' selected' : ''}`}>
                <input
                  type="radio"
                  name="ondo-radio-dialog"
                  checked={radioSel === opt.value}
                  onChange={() => setRadioSel(opt.value)}
                />
                <span className="radio-label">{opt.label}</span>
              </label>
            ))}
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => close(null)}>{state.cancelLabel}</button>
            <button className="btn btn-primary" onClick={() => close(radioSel)}>{state.confirmLabel}</button>
          </div>
        </div>
      </div>
    );
  }

  // Scelta multipla (M55): un pulsante per opzione, ciascuno con etichetta e una
  // riga di descrizione sotto; impilati in verticale perché le opzioni possono
  // essere prolisse (es. "Video 2160p + audio 720p (fuso)").
  if (isChoice) {
    return (
      <div className="modal-overlay" onClick={() => close(null)}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3>{state.title}</h3>
          {state.message && <p>{state.message}</p>}
          <div className="modal-choices">
            {state.options.map((opt) => (
              <button key={opt.value} className="choice-btn" onClick={() => close(opt.value)}>
                <span className="choice-label">{opt.label}</span>
                {opt.description && <span className="choice-desc">{opt.description}</span>}
              </button>
            ))}
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => close(null)}>{state.cancelLabel}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={() => close(cancelValue)}>
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
