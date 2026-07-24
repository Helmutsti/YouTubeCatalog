import { useNavigate, useLocation } from 'react-router-dom';
import { popNextInQueue } from '../lib/queueStore.js';
import { getPlayerState, setCurrent, setPlaying } from '../lib/playerStore.js';
import { getVideo } from '../api/client.js';

// Avanzamento della coda di riproduzione (M52 + M57) — PERCORSO UNICO condiviso
// da MiniPlayer (onEnded, fine video) e dai pulsanti "Successivo" manuali di
// VideoDetailPage (M57), così le due strade non divergono mai (principio M57).
//
// Comportamento (lo stesso introdotto in M54 per la fine video):
//  - esiste un elemento <video> vivo (agganciato alla pagina O nel riquadro
//    flottante) → si scambia la sorgente SU QUELLO STESSO elemento (nessuna
//    ricreazione); se era agganciato si aggiorna anche la route. È la chiave
//    dell'autoplay a fine video (M60-fix, vedi sotto);
//  - nessun player attivo (es. video corrente non scaricato) → si naviga con
//    `state.autoplay` (default predittibile).
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

    // Se esiste già un elemento <video> vivo — nel riquadro flottante O
    // agganciato a questa pagina — scambiamo la sorgente SU QUELLO invece di
    // far ricreare un elemento nuovo. È la chiave dell'autoplay a fine video
    // (M60-fix): il browser consente la riproduzione continua su un elemento
    // che l'utente ha già avviato, ma blocca l'autoplay (a fine video non c'è
    // un gesto utente) su un elemento appena creato. Prima il ramo "docked"
    // faceva navigate(state.autoplay): la navigazione azzerava e RICREAVA il
    // player (clear() nell'effetto di transizione di MiniPlayer), quindi il
    // successivo era un elemento nuovo e restava fermo. Ora, da agganciati, si
    // fa setCurrent(play) + navigate nello STESSO tick: React raggruppa i due
    // aggiornamenti e il player passa da docked(old) a docked(new) senza un
    // frame intermedio che smonterebbe l'elemento (il reparenting M54 resta lo
    // stesso: l'elemento non viene mai ricreato, quindi mantiene il permesso di
    // riproduzione del browser).
    if (st.current) {
      try {
        const full = await getVideo(next.id);
        setCurrent(full, { play: true });
        if (dockedNow) navigate(`/videos/${next.id}`);
        return;
      } catch {
        // Precaricamento fallito: ripiego sul vecchio percorso di navigazione.
      }
    }
    // Nessun player attivo (es. video corrente non scaricato): navigazione
    // predittibile con richiesta di autoplay sulla pagina di destinazione.
    navigate(`/videos/${next.id}`, { state: { autoplay: true } });
  };
}
