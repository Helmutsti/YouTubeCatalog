import { readCatalog, updateCatalog } from '../../catalog/catalogStore.js';
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

  for (const candidate of candidates) {
    const id = candidate.id;
    log(`--- ${id}: ${candidate.title ?? '(titolo sconosciuto)'} ---`);

    await updateCatalog((cat) => {
      cat.videos[id].download = DOWNLOAD_STATE.DOWNLOADING;
      cat.videos[id].error = null;
      cat.videos[id].updatedAt = new Date().toISOString();
    });

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
        log(`Lotto interrotto dall'utente: ${candidates.length - results.length} video rimasti non avviati.`);
        break;
      }
    }
  }

  log(`Completato: ${downloaded} scaricati, ${failed} falliti.`);
  return { downloaded, failed, total: candidates.length, results };
}
