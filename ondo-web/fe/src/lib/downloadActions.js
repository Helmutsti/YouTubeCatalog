import { apiUrl } from './apiBase.js';
import { getConfig, getVideo, downloadVideoById } from '../api/client.js';
import { showToast, updateToast, dismissToast } from './toast.js';
import { appNavigate } from './navigation.js';
import { trackVideoDownload, untrackVideoDownload } from './downloadTracker.js';
import { confirmDialog, radioDialog } from './dialog.js';

// I livelli offerti, gli stessi della CLI. Prima l'elenco arrivava dal server, che
// sondava i formati disponibili prima di scaricare (`analyzeDownload`): il core non
// ha quella funzione, quindi si offre una scala fissa e ci pensa yt-dlp a prendere
// "quella o la migliore sotto".
const LIVELLI = [null, 2160, 1440, 1080, 720, 480, 360];

// Aspetta che il job finisca ascoltando gli eventi del server.
//
// Prima si interrogava `/api/jobs/:id` ogni 400 ms; adesso c'è un flusso SSE con
// tutti gli eventi, quindi si sta in ascolto invece di chiedere. `onRunning` scatta
// alla prima fase davvero iniziata: serve alle pagine per mostrare il pallino "in
// download" senza aspettare la fine.
function attendiJob(jobId, onRunning) {
  return new Promise((resolve) => {
    const source = new EventSource(apiUrl('/api/events'));
    const atteso = String(jobId);
    let avviato = false;
    const chiudi = (esito) => {
      source.close();
      resolve(esito);
    };
    source.onmessage = (e) => {
      let update;
      try {
        update = JSON.parse(e.data);
      } catch {
        return;
      }
      if (String(update.job) !== atteso) return;
      const ev = update.event ?? {};
      if (!avviato && (ev.event === 'phase' || ev.event === 'progress')) {
        avviato = true;
        onRunning?.();
      }
      if (ev.event === 'done') chiudi({ status: 'success' });
      if (ev.event === 'error') chiudi({ status: 'failed', error: { message: ev.message } });
    };
    // Se il flusso cade, non si resta appesi: si considera concluso e la pagina
    // ricaricherà lo stato vero dal catalogo.
    source.onerror = () => chiudi({ status: 'unknown' });
  });
}

// Avvia il download di un video già in libreria, con feedback via toast: il toast
// resta visibile e diventa verde o rosso da solo quando il job termina, senza
// spostare l'utente dalla pagina in cui si trova.
//
// `onSettled` viene chiamato sia quando il download parte davvero (per far comparire
// il pallino "in download") sia alla fine (per riflettere l'esito): tipicamente è il
// `reload()` della pagina chiamante.
export async function startDownload(videoId, { onSettled, title } = {}) {
  const label = title ? `"${title}"` : 'Video';

  // Se c'è già una copia scaricata, si chiede: riscaricare sostituisce il file, e
  // farlo a sorpresa sarebbe sbagliato.
  let video = null;
  try {
    video = await getVideo(videoId);
  } catch {
    /* se non si riesce a leggerlo, si prova comunque a scaricare */
  }
  if (video?.download === 'downloaded') {
    const ok = await confirmDialog({
      title: 'Video già scaricato',
      message: 'Esiste già una copia scaricata. Scaricarlo di nuovo, sostituendo il file?',
      confirmLabel: 'Scarica di nuovo',
      danger: true
    });
    if (!ok) return;
  }

  // La risoluzione si chiede solo se le impostazioni dicono «chiedi ogni volta»:
  // altrimenti vale la qualità predefinita, come nella CLI.
  let maxHeight;
  try {
    const cfg = await getConfig();
    if (cfg.quality === 'ask') {
      const scelta = await radioDialog({
        title: 'Scegli la risoluzione',
        message: `A quale risoluzione scaricare ${label}?`,
        options: LIVELLI.map((h) => ({ value: h ?? 'best', label: h ? `${h}p (o la migliore sotto)` : 'Massima' })),
        defaultValue: 'best',
        confirmLabel: 'Scarica'
      });
      if (scelta == null) return; // annullato
      maxHeight = scelta === 'best' ? null : scelta;
    }
  } catch {
    /* senza config si usa il default del server */
  }

  const toastId = showToast(`${label}: download avviato…`, 'info', 0, () => appNavigate('/'));
  let jobId;
  try {
    ({ job: jobId } = await downloadVideoById(videoId, { maxHeight }));
    // Da qui la card del video può agganciarsi al progresso reale via useJobStream.
    trackVideoDownload(videoId, jobId);
    const esito = await attendiJob(jobId, onSettled);
    if (esito.status === 'failed') {
      updateToast(toastId, { message: `${label}: download fallito (${esito.error?.message ?? 'errore sconosciuto'})`, type: 'error' });
    } else if (esito.status === 'success') {
      updateToast(toastId, { message: `${label}: download completato.`, type: 'success' });
    } else {
      dismissToast(toastId);
    }
    onSettled?.();
  } catch (e) {
    updateToast(toastId, { message: `${label}: download fallito (${e.message})`, type: 'error' });
    onSettled?.();
  } finally {
    if (jobId) untrackVideoDownload(videoId);
  }
}
