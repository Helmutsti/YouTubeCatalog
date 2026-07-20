import { readCatalog } from '../catalog/catalogStore.js';

export async function listVideos({ status } = {}) {
  const catalog = await readCatalog();
  const videos = Object.values(catalog.videos);
  const filtered = status ? videos.filter((v) => v.status === status) : videos;
  return filtered.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
}

export async function getVideo(id) {
  const catalog = await readCatalog();
  const video = catalog.videos[id];
  if (!video) throw new Error(`Video non trovato nel catalogo: ${id}`);
  return video;
}

export async function listNew() {
  return listVideos({ status: 'new' });
}

function channelKey(video) {
  return video.channel?.id ?? video.channel?.name ?? null;
}

export async function listChannels({ status = 'downloaded' } = {}) {
  const videos = await listVideos({ status });
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

export async function listVideosByChannel(channelKeyValue, { status = 'downloaded' } = {}) {
  const videos = await listVideos({ status });
  return videos.filter((v) => channelKey(v) === channelKeyValue);
}
