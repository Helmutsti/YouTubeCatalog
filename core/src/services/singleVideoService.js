import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';
import { createNewVideoStub, VIDEO_STATUS } from '../catalog/catalogSchema.js';

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

// Estrae l'id video da un link YouTube incollato (watch/youtu.be/shorts/live/
// embed) o da un id nudo di 11 caratteri. Un eventuale "list=" in un URL
// watch?v=...&list=... viene ignorato deliberatamente: qui si vuole sempre e
// solo il singolo video, mai la playlist che lo contiene.
export function extractVideoId(input) {
  const trimmed = (input ?? '').trim();
  if (YOUTUBE_ID_PATTERN.test(trimmed)) return trimmed;

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '');

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return YOUTUBE_ID_PATTERN.test(id) ? id : null;
  }

  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (url.pathname === '/watch') {
      const id = url.searchParams.get('v');
      return id && YOUTUBE_ID_PATTERN.test(id) ? id : null;
    }
    const match = url.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})/);
    if (match) return match[1];
  }

  return null;
}

// Prepara il download one-off di un singolo video, senza passare da una fonte
// (sourcelist/sync di playlist). Non scarica direttamente: il chiamante,
// se action === 'download', lancia il job già esistente 'downloadSingle'.
export async function prepareSingleVideoDownload(url) {
  const videoId = extractVideoId(url);
  if (!videoId) {
    throw new Error('URL non riconosciuto: atteso un link YouTube (watch/youtu.be/shorts/live) o un id di 11 caratteri.');
  }

  const catalog = await readCatalog();
  const existing = catalog.videos[videoId];

  if (existing) {
    if (existing.status === VIDEO_STATUS.DOWNLOADED) {
      return { videoId, action: 'already-downloaded', title: existing.title };
    }
    if (existing.status === VIDEO_STATUS.DOWNLOADING) {
      return { videoId, action: 'already-downloading', title: existing.title };
    }
    // new/pending/failed/excluded: già tracciato tramite una fonte esistente,
    // la revisione va fatta da "Rivedi novità", non forzata da qui.
    return { videoId, action: 'already-tracked', status: existing.status, title: existing.title };
  }

  await updateCatalog((cat) => {
    if (cat.videos[videoId]) return;
    const stub = createNewVideoStub({ id: videoId });
    stub.status = VIDEO_STATUS.PENDING;
    // Mai legato a una fonte: nessuna sync di playlist enumererà mai questo id.
    stub.source = { sourceId: null, type: 'single' };
    stub.decidedAt = new Date().toISOString();
    cat.videos[videoId] = stub;
  });

  return { videoId, action: 'download', title: null };
}
