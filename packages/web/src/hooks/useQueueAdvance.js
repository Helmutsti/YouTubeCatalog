import { useNavigate, useLocation } from 'react-router-dom';
import { popNextInQueue } from '../lib/queueStore.js';
import { getPlayerState, setCurrent, setPlaying, clear } from '../lib/playerStore.js';
import { getVideo } from '../api/client.js';

// Avanzamento della coda di riproduzione (M52 + M57) — PERCORSO UNICO condiviso
// da MiniPlayer (onEnded, fine video) e dai pulsanti "Successivo" manuali di
// VideoDetailPage (M57), così le due strade non divergono mai (principio M57).
//
// Comportamento (lo stesso introdotto in M54 per la fine video):
//  - player AGGANCIATO alla pagina del suo video (docked) → si naviga al
//    successivo con `state.autoplay` (la pagina lo aggancia e lo avvia);
//  - player nel riquadro flottante (staccato/minimizzato) → si carica e riproduce
//    il successivo SENZA cambiare pagina — coerente con la rifinitura M54
//    "minimizza non deve uscire dalla pagina corrente";
//  - nessun player attivo (es. video corrente non scaricato) → si naviga
//    (default predittibile).
//
// `docked`/floating si leggono dallo stato FRESCO dello store al momento del
// click (getPlayerState), non dalle closure di render, che durante una
// navigazione potrebbero essere sfasate — stesso accorgimento della transizione
// di pagina in MiniPlayer.
export function useQueueAdvance() {
  const navigate = useNavigate();
  const location = useLocation();
  return async function goToNext({ currentId = null } = {}) {
    setPlaying(false);
    let next = popNextInQueue();
    // Guardia edge-case (M57): scarta la testa finché coincide col video già in
    // visione (l'utente ha accodato il video che sta guardando), per non
    // "avanzare" allo stesso video. Inattiva a fine video (currentId null: il
    // video finito è già stato tolto dalla coda dall'autoplay).
    while (next && currentId && next.id === currentId) next = popNextInQueue();
    if (!next) return;

    const st = getPlayerState();
    const dockedNow = st.current && !st.minimized && location.pathname === `/videos/${st.current.id}`;
    // C'è un player nel riquadro flottante in cui far entrare il successivo?
    // (sì solo se esiste un corrente e NON è agganciato a questa pagina)
    const canSwapInFloat = st.current && !dockedNow;

    if (canSwapInFloat) {
      try {
        const full = await getVideo(next.id);
        setCurrent(full, { play: true });
      } catch {
        clear();
      }
      return;
    }
    navigate(`/videos/${next.id}`, { state: { autoplay: true } });
  };
}
