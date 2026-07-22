import { getJob } from '../api/client.js';
import { showToast, updateToast } from './toast.js';
import { appNavigate } from './navigation.js';

// onRunning: chiamato la PRIMA volta che il job risulta 'running' (non subito
// dopo l'accodamento). Bug reale trovato in verifica: chiamare il refresh
// subito dopo triggerJob() è una race — a quel punto il job è solo 'queued',
// jobManager.js lo marca 'running' e passa il controllo all'handler solo dopo
// (che è lui a scrivere download:'downloading' sul video); un refresh troppo
// anticipato rilegge ancora lo stato vecchio, e senza nessun altro refresh
// programmato prima del termine, il video sembrava "sparire" direttamente da
// "Da scaricare" a "Scaricato" senza mai mostrare il pallino "in download".
function waitForJobTerminal(jobId, onRunning) {
  return new Promise((resolve) => {
    let notifiedRunning = false;
    const tick = async () => {
      try {
        const j = await getJob(jobId);
        if (j) {
          if (!notifiedRunning && j.status === 'running') {
            notifiedRunning = true;
            onRunning?.();
          }
          if (j.status === 'success' || j.status === 'failed') return resolve(j);
        }
      } catch { /* riprova */ }
      setTimeout(tick, 400);
    };
    tick();
  });
}

// Avvia il download di un video con feedback via toast (niente più
// navigazione forzata a Sorgenti, cambio deciso dall'utente): un toast
// "Download avviato…" resta visibile e diventa verde/rosso da solo quando il
// job termina, senza spostare l'utente dalla pagina in cui si trovava. Il job
// resta comunque visibile in Cronologia su Sorgenti per chi ci passa mentre è
// ancora in corso — nessuna modifica lì, è lo stesso storico di sempre.
//
// onSettled (opzionale): la pagina chiamante non riceve più nessun evento
// realtime sullo stato del video (niente più redirect/polling automatico), per
// cui senza questo callback la card resterebbe visivamente ferma allo stato
// precedente (niente pallino "in download" pulsante, "Da scaricare" invariato)
// finché l'utente non naviga altrove e torna — bug reale trovato in verifica.
// Chiamato sia subito dopo l'accodamento (per mostrare "in download") sia a
// fine job (per riflettere l'esito finale) — tipicamente il `reload()`/
// `reSearch()` già esistente in ogni pagina.
// title (opzionale): mostrato nel toast; il toast resta cliccabile per tutta
// la sua vita (anche dopo essere diventato verde/rosso) e porta su Sorgenti,
// dove il job è comunque visibile in Cronologia lavorazioni.
export async function startDownload(videoId, { triggerJob, onSettled, title }) {
  const label = title ? `"${title}"` : 'Video';
  const toastId = showToast(`${label}: download avviato…`, 'info', 0, () => appNavigate('/sources'));
  try {
    const { jobId } = await triggerJob('downloadSingle', { videoId });
    const job = await waitForJobTerminal(jobId, onSettled);
    if (job.status === 'failed') {
      updateToast(toastId, { message: `${label}: download fallito (${job.error?.message ?? 'errore sconosciuto'})`, type: 'error' });
    } else {
      updateToast(toastId, { message: `${label}: download completato.`, type: 'success' });
    }
    onSettled?.();
  } catch (e) {
    updateToast(toastId, { message: `${label}: download fallito (${e.message})`, type: 'error' });
    onSettled?.();
  }
}
