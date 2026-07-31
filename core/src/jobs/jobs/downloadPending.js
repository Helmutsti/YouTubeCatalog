import { readCatalog, updateCatalog, claimVideosForDownload } from '../../catalog/catalogStore.js';
import { DOWNLOAD_STATE } from '../../catalog/catalogSchema.js';
import { downloadVideo } from '../../ytdlp/ytdlpWrapper.js';

// Download "in blocco" (M25): riceve una lista esplicita di id da scaricare
// (params.videoIds) — è la selezione multipla della Libreria (M28). Il vecchio
// concetto di coda "pending" è sparito col modello a flag ortogonali: non si
// scansiona più il catalogo per stato, si scarica esattamente ciò che è stato
// scelto. Salta gli id già scaricati o in download; l'ordine è quello passato.
export async function downloadPendingJob(params, { log, progress, signal }) {
  const requestedIds = Array.isArray(params?.videoIds) ? params.videoIds : [];

  const catalog = await readCatalog();

  const candidates = requestedIds
    .map((id) => catalog.videos[id])
    .filter((v) => v && v.download !== DOWNLOAD_STATE.DOWNLOADED && v.download !== DOWNLOAD_STATE.DOWNLOADING);

  if (candidates.length === 0) {
    log('Nessun video da scaricare (lista vuota o già tutti scaricati).');
    return { downloaded: 0, failed: 0, total: 0, results: [] };
  }

  log(`${candidates.length} video da scaricare.`);

  let downloaded = 0;
  let failed = 0;
  // Elenco per-video (M20): lo storico mostra le thumbnail dei video toccati.
  const results = [];
  let skipped = 0;

  for (const requested of candidates) {
    // Presa in carico atomica (M75), **una per volta e dentro il ciclo**, non in
    // blocco prima di partire: marcare subito tutto il lotto `downloading`
    // mostrerebbe venti video "in corso" quando ne sta scaricando uno solo, e
    // all'interruzione i non partiti resterebbero appesi in quello stato.
    // Il filtro qui sopra decide su dati che, con più job in parallelo, possono
    // essere già superati quando arriva il turno di questo video: è `claim` a
    // dire l'ultima parola, dentro il mutex. Lista vuota = un altro job se l'è
    // preso nel frattempo, quindi si salta invece di scaricarlo due volte.
    const [candidate] = await claimVideosForDownload([requested.id]);
    if (!candidate) {
      skipped += 1;
      log(`↷ ${requested.id} saltato: un altro download lo ha già preso in carico.`);
      continue;
    }
    const id = candidate.id;
    log(`--- ${id}: ${candidate.title ?? '(titolo sconosciuto)'} ---`);

    try {
      const fields = await downloadVideo(id, candidate.webpageUrl, { onLog: log, onProgress: progress, signal });
      await updateCatalog((cat) => {
        Object.assign(cat.videos[id], fields, {
          download: DOWNLOAD_STATE.DOWNLOADED,
          updatedAt: new Date().toISOString(),
          error: null
        });
      });
      downloaded += 1;
      results.push({ id, status: 'downloaded' });
      log(`✔ ${id} scaricato con successo.`);
    } catch (err) {
      await updateCatalog((cat) => {
        const v = cat.videos[id];
        v.download = DOWNLOAD_STATE.FAILED;
        v.attempts = (v.attempts ?? 0) + 1;
        v.error = { message: err.message, occurredAt: new Date().toISOString(), attempts: v.attempts };
        v.updatedAt = new Date().toISOString();
      });
      failed += 1;
      results.push({ id, status: 'failed' });
      log(`✘ ${id} fallito: ${err.message}`);
      // Interruzione manuale (M51): ferma subito l'intero lotto, i video
      // successivi restano "da scaricare" — mai avviati, non solo saltati.
      if (signal?.aborted) {
        log(`Lotto interrotto dall'utente: ${candidates.length - results.length - skipped} video rimasti non avviati.`);
        break;
      }
    }
  }

  // `skipped` sono i video che un altro download in parallelo aveva già preso in
  // carico: non sono né riusciti né falliti per noi, quindi si dicono a parte
  // invece di sparire dal conto.
  log(`Completato: ${downloaded} scaricati, ${failed} falliti${skipped ? `, ${skipped} saltati (già in corso altrove)` : ''}.`);
  return { downloaded, failed, skipped, total: candidates.length, results };
}
