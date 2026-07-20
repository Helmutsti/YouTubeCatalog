import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';
import { createNewVideoStub, VIDEO_STATUS } from '../catalog/catalogSchema.js';
import { resolveVideoInfo } from '../ytdlp/ytdlpWrapper.js';

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

// Un id YouTube nudo (senza URL) resta comodo da incollare ed è l'unico caso
// in cui possiamo costruire noi l'URL senza ambiguità. Per qualunque altro
// input serve un URL vero e proprio: id di altri siti (es. Rumble) non hanno
// un formato prevedibile, li risolve yt-dlp stesso.
function normalizeToUrl(input) {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return null;
  if (YOUTUBE_ID_PATTERN.test(trimmed)) {
    return `https://www.youtube.com/watch?v=${trimmed}`;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
}

// Prepara il download one-off di un singolo video, senza passare da una fonte
// (sourcelist/sync di playlist). Accetta qualunque sito supportato da yt-dlp
// (YouTube, Rumble, ecc.) — l'id/titolo/canale vengono risolti da yt-dlp
// stesso, non indovinati con un regex specifico di YouTube. Non scarica
// direttamente: il chiamante, se action === 'download', lancia il job già
// esistente 'downloadSingle'.
export async function prepareSingleVideoDownload(input) {
  const url = normalizeToUrl(input);
  if (!url) {
    throw new Error('URL non riconosciuto: incolla un link (YouTube, Rumble o un altro sito supportato da yt-dlp) oppure un id YouTube di 11 caratteri.');
  }

  const info = await resolveVideoInfo(url);
  if (!info.id) {
    throw new Error('yt-dlp non è riuscito a determinare un id per questo video.');
  }

  const catalog = await readCatalog();
  const existing = catalog.videos[info.id];

  if (existing) {
    if (existing.status === VIDEO_STATUS.DOWNLOADED) {
      return { videoId: info.id, action: 'already-downloaded', title: existing.title };
    }
    if (existing.status === VIDEO_STATUS.DOWNLOADING) {
      return { videoId: info.id, action: 'already-downloading', title: existing.title };
    }
    // new/pending/failed/excluded: già tracciato tramite una fonte esistente,
    // la revisione va fatta da "Rivedi novità", non forzata da qui.
    return { videoId: info.id, action: 'already-tracked', status: existing.status, title: existing.title };
  }

  await updateCatalog((cat) => {
    if (cat.videos[info.id]) return;
    const stub = createNewVideoStub({
      id: info.id,
      title: info.title,
      channelName: info.channelName,
      durationSeconds: info.durationSeconds,
      webpageUrl: info.webpageUrl,
      originalUrl: url,
      extractor: info.extractor
    });
    stub.status = VIDEO_STATUS.PENDING;
    // Mai legato a una fonte: nessuna sync di playlist enumererà mai questo id.
    stub.source = { sourceId: null, type: 'single' };
    stub.decidedAt = new Date().toISOString();
    cat.videos[info.id] = stub;
  });

  return { videoId: info.id, action: 'download', title: info.title };
}
