import { getJob, analyzeDownload, downloadVideoById } from '../api/client.js';
import { showToast, updateToast, dismissToast } from './toast.js';
import { appNavigate } from './navigation.js';
import { trackVideoDownload, untrackVideoDownload } from './downloadTracker.js';
import { confirmDialog, choiceDialog, radioDialog } from './dialog.js';

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
//
// M55: prima di avviare, si passa da analyzeDownload() per due decisioni che
// solo l'utente può prendere e che altrimenti verrebbero prese silenziosamente:
//   - se esiste già una copia scaricata, confermare "elimina e ri-scarica"
//     (senza conferma si sovrascriverebbe un file già presente a sorpresa);
//   - se il miglior video non ha un audio già combinato alla sua risoluzione,
//     scegliere fra qualità uniforme più bassa (combined) e video alla massima
//     risoluzione con audio inferiore fuso (merged).
// Il parametro `triggerJob` resta nella firma per compatibilità coi chiamanti,
// ma non è più usato: il job parte via downloadVideoById() (endpoint dedicato
// che accetta audioStrategy/deleteFirst). Se l'utente annulla uno dei due
// prompt, si esce silenziosamente senza avviare né mostrare toast di errore.
export async function startDownload(videoId, { triggerJob, onSettled, title }) {
  const label = title ? `"${title}"` : 'Video';

  // La sonda formati (analyzeDownload) può richiedere qualche secondo: senza
  // feedback, dopo il click sembrerebbe che non succeda nulla. Un toast
  // persistente "analisi formati…" copre l'attesa; poi diventa "download
  // avviato…" (nessun prompt) o viene tolto se sta per comparire un modale.
  const analyzingId = showToast(`${label}: analisi formati…`, 'info', 0, () => appNavigate('/sources'));

  let analysis;
  try {
    analysis = await analyzeDownload({ videoId });
  } catch (e) {
    updateToast(analyzingId, { message: `${label}: impossibile analizzare il download (${e.message})`, type: 'error' });
    return;
  }

  // Qualunque modale (confirm/scelta/risoluzione) toglie il toast di analisi,
  // che resterebbe dietro. Riusato come toast di avvio solo se NON compare alcun
  // modale (raro: nessuna risoluzione nota e nessun altro caso).
  const heights = analysis.availableHeights ?? [];
  const willPrompt = analysis.alreadyDownloaded || heights.length > 0 || analysis.needsAudioChoice;
  if (willPrompt) dismissToast(analyzingId);

  let deleteFirst = false;
  if (analysis.alreadyDownloaded) {
    const ok = await confirmDialog({
      title: 'Video già scaricato',
      message: 'Esiste già una copia scaricata. Vuoi eliminarla e ri-scaricare?',
      confirmLabel: 'Elimina e ri-scarica',
      danger: true
    });
    if (!ok) return; // annullato: non si tocca la copia esistente
    deleteFirst = true;
  }

  // M56: scelta della risoluzione (sempre, se ci sono formati noti). La più alta
  // è "(massima)" e passa maxHeight=null (nessun cap → il meglio disponibile al
  // momento del download); le altre cappano a quell'altezza.
  let maxHeight; // undefined = default di config
  if (heights.length > 0) {
    const picked = await radioDialog({
      title: 'Scegli la risoluzione',
      message: `A quale risoluzione scaricare ${label}?`,
      options: heights.map((h, i) => ({ value: h, label: i === 0 ? `${h}p (massima)` : `${h}p` })),
      defaultValue: heights[0],
      confirmLabel: 'Scarica'
    });
    if (picked == null) return; // annullato
    maxHeight = picked === heights[0] ? null : picked;
  }

  let audioStrategy;
  if (analysis.needsAudioChoice) {
    const choice = await choiceDialog({
      title: 'Scegli la qualità',
      message: 'Il video alla massima risoluzione non ha un audio già abbinato: scegli come procedere.',
      options: [
        {
          value: 'combined',
          label: `Scarica a ${analysis.maxCombinedHeight}p`,
          description: 'Audio e video insieme, qualità uniforme.'
        },
        {
          value: 'merged',
          label: `Video ${analysis.maxVideoHeight}p + audio ${analysis.maxCombinedHeight}p`,
          description: 'Video alla massima risoluzione, audio di qualità inferiore (fuso).'
        }
      ]
    });
    if (!choice) return; // annullato
    audioStrategy = choice;
  }

  // Riusa il toast di analisi se non è comparso alcun modale; altrimenti nuovo.
  let toastId = analyzingId;
  if (willPrompt) {
    toastId = showToast(`${label}: download avviato…`, 'info', 0, () => appNavigate('/sources'));
  } else {
    updateToast(analyzingId, { message: `${label}: download avviato…`, type: 'info' }, 0);
  }
  let jobId;
  try {
    ({ jobId } = await downloadVideoById(videoId, { audioStrategy, deleteFirst, maxHeight }));
    // Da qui in poi la card del video (in qualunque griglia sia montata) può
    // agganciarsi al progresso reale via useJobStream(jobId).
    trackVideoDownload(videoId, jobId);
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
  } finally {
    if (jobId) untrackVideoDownload(videoId);
  }
}
