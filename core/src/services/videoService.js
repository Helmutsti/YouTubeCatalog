import { readCatalog } from '../catalog/catalogStore.js';
import { DOWNLOAD_STATE, PRESENCE, isDownloaded } from '../catalog/catalogSchema.js';

// Filtro sui flag ortogonali (M25): ogni criterio passato deve combaciare
// (AND). Omettere un criterio = non filtrare su quell'asse.
export async function listVideos({ presence, download, hidden } = {}) {
  const catalog = await readCatalog();
  let videos = Object.values(catalog.videos);
  if (presence !== undefined) videos = videos.filter((v) => v.presence === presence);
  if (download !== undefined) videos = videos.filter((v) => v.download === download);
  if (hidden !== undefined) videos = videos.filter((v) => !!v.hidden === !!hidden);
  return videos.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
}

export async function getVideo(id) {
  const catalog = await readCatalog();
  const video = catalog.videos[id];
  if (!video) throw new Error(`Video non trovato nel catalogo: ${id}`);
  return video;
}

// "Disponibili": presenti su YouTube, non ancora scaricati, non nascosti —
// i video su cui ha senso proporre il download. Sostituisce l'ex listNew().
export async function listAvailable() {
  return listVideos({ presence: PRESENCE.PRESENT, download: DOWNLOAD_STATE.NONE, hidden: false });
}

export function channelKey(video) {
  return video.channel?.id ?? video.channel?.name ?? null;
}

export async function listChannels({ download = DOWNLOAD_STATE.DOWNLOADED } = {}) {
  const videos = await listVideos({ download });
  const channels = new Map();

  for (const video of videos) {
    const key = channelKey(video);
    if (!key) continue;
    if (!channels.has(key)) {
      channels.set(key, { key, id: video.channel.id, name: video.channel.name, count: 0 });
    }
    channels.get(key).count += 1;
  }

  return [...channels.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export async function listVideosByChannel(channelKeyValue, { download = DOWNLOAD_STATE.DOWNLOADED } = {}) {
  const videos = await listVideos({ download });
  return videos.filter((v) => channelKey(v) === channelKeyValue);
}

export { isDownloaded };
