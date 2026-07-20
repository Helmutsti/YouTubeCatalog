import { loadConfig } from '../../config.js';
import { readCatalog, updateCatalog } from '../../catalog/catalogStore.js';
import { VIDEO_STATUS } from '../../catalog/catalogSchema.js';
import { downloadVideo } from '../../ytdlp/ytdlpWrapper.js';

export async function downloadPendingJob(params, { log, progress }) {
  const config = loadConfig();
  const maxAttempts = config.jobs.maxAttempts;
  const catalog = await readCatalog();
  const candidates = Object.values(catalog.videos).filter(
    (v) => v.status === VIDEO_STATUS.PENDING || (v.status === VIDEO_STATUS.FAILED && v.attempts < maxAttempts)
  );

  if (candidates.length === 0) {
    log('Nessun video in coda per il download.');
    return { downloaded: 0, failed: 0, total: 0 };
  }

  log(`${candidates.length} video da scaricare.`);

  let downloaded = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const id = candidate.id;
    log(`--- ${id}: ${candidate.title ?? '(titolo sconosciuto)'} ---`);

    await updateCatalog((cat) => {
      cat.videos[id].status = VIDEO_STATUS.DOWNLOADING;
      cat.videos[id].updatedAt = new Date().toISOString();
    });

    try {
      const fields = await downloadVideo(id, { onLog: log, onProgress: progress });
      await updateCatalog((cat) => {
        Object.assign(cat.videos[id], fields, {
          status: VIDEO_STATUS.DOWNLOADED,
          updatedAt: new Date().toISOString(),
          error: null
        });
      });
      downloaded += 1;
      log(`✔ ${id} scaricato con successo.`);
    } catch (err) {
      await updateCatalog((cat) => {
        const v = cat.videos[id];
        v.status = VIDEO_STATUS.FAILED;
        v.attempts = (v.attempts ?? 0) + 1;
        v.error = { message: err.message, occurredAt: new Date().toISOString(), attempts: v.attempts };
        v.updatedAt = new Date().toISOString();
      });
      failed += 1;
      log(`✘ ${id} fallito: ${err.message}`);
    }
  }

  log(`Completato: ${downloaded} scaricati, ${failed} falliti.`);
  return { downloaded, failed, total: candidates.length };
}
