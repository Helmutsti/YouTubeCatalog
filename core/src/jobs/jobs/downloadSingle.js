import { readCatalog, updateCatalog } from '../../catalog/catalogStore.js';
import { DOWNLOAD_STATE } from '../../catalog/catalogSchema.js';
import { downloadVideo } from '../../ytdlp/ytdlpWrapper.js';

export async function downloadSingleJob(params, { log, progress }) {
  const { videoId } = params;
  if (!videoId) throw new Error('downloadSingle richiede il parametro "videoId"');

  const catalog = await readCatalog();
  const video = catalog.videos[videoId];
  if (!video) throw new Error(`Video non trovato nel catalogo: ${videoId}`);

  log(`--- ${videoId}: ${video.title ?? '(titolo sconosciuto)'} ---`);

  await updateCatalog((cat) => {
    cat.videos[videoId].download = DOWNLOAD_STATE.DOWNLOADING;
    cat.videos[videoId].error = null;
    cat.videos[videoId].updatedAt = new Date().toISOString();
  });

  try {
    const fields = await downloadVideo(videoId, video.webpageUrl, { onLog: log, onProgress: progress });
    await updateCatalog((cat) => {
      Object.assign(cat.videos[videoId], fields, {
        download: DOWNLOAD_STATE.DOWNLOADED,
        updatedAt: new Date().toISOString(),
        error: null
      });
    });
    log(`✔ ${videoId} scaricato con successo.`);
    return { downloaded: 1, failed: 0 };
  } catch (err) {
    await updateCatalog((cat) => {
      const v = cat.videos[videoId];
      v.download = DOWNLOAD_STATE.FAILED;
      v.attempts = (v.attempts ?? 0) + 1;
      v.error = { message: err.message, occurredAt: new Date().toISOString(), attempts: v.attempts };
      v.updatedAt = new Date().toISOString();
    });
    log(`✘ ${videoId} fallito: ${err.message}`);
    throw err;
  }
}
