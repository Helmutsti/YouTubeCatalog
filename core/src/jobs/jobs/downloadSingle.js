import { readCatalog, updateCatalog } from '../../catalog/catalogStore.js';
import { DOWNLOAD_STATE } from '../../catalog/catalogSchema.js';
import { downloadVideo, isVideoGoneError } from '../../ytdlp/ytdlpWrapper.js';
import { syncChannelAvatars } from '../../services/channelAvatarService.js';
import { markVideoRemoved } from '../../services/metadataService.js';

export async function downloadSingleJob(params, { log, progress, signal }) {
  const { videoId, audioStrategy, maxHeight } = params;
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
    const fields = await downloadVideo(videoId, video.webpageUrl, { onLog: log, onProgress: progress, signal, audioStrategy, maxHeight });
    await updateCatalog((cat) => {
      Object.assign(cat.videos[videoId], fields, {
        download: DOWNLOAD_STATE.DOWNLOADED,
        updatedAt: new Date().toISOString(),
        error: null
      });
    });
    log(`✔ ${videoId} scaricato con successo.`);

    // Come in addVideoJob/enrichSourceJob: un video può introdurre un creator
    // ancora senza foto profilo (es. scaricato subito da un link, senza mai
    // passare da "aggiungi"). force:false salta chi ce l'ha già.
    try {
      const a = await syncChannelAvatars({ force: false });
      if (a.fetchedCount) log(`Foto profilo creator scaricata (${a.fetchedCount}).`);
    } catch (err) {
      log(`Foto profilo creator non aggiornata: ${err.message}`);
    }

    return { downloaded: 1, failed: 0 };
  } catch (err) {
    await updateCatalog((cat) => {
      const v = cat.videos[videoId];
      v.download = DOWNLOAD_STATE.FAILED;
      v.attempts = (v.attempts ?? 0) + 1;
      v.error = { message: err.message, occurredAt: new Date().toISOString(), attempts: v.attempts };
      v.updatedAt = new Date().toISOString();
    });
    if (isVideoGoneError(err)) {
      await markVideoRemoved(videoId);
      log(`⊘ ${videoId} è privato — segnato come "Rimosso".`);
    }
    log(`✘ ${videoId} fallito: ${err.message}`);
    throw err;
  }
}
