import { getPaths } from '../config.js';
import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';
import { getPlaylistEntries } from '../ytdlp/ytdlpWrapper.js';
import { extractPlaylistId, ingestPlaylistEntries } from './syncService.js';

export async function listSources() {
  const catalog = await readCatalog();
  const counts = {};
  for (const video of Object.values(catalog.videos)) {
    const sourceId = video.source?.sourceId;
    if (!sourceId) continue;
    counts[sourceId] = (counts[sourceId] ?? 0) + 1;
  }

  return Object.values(catalog.sources)
    .map((source) => ({ ...source, videoCount: counts[source.id] ?? 0 }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export async function addSource(url) {
  const playlistId = extractPlaylistId(url);
  if (!playlistId) {
    throw new Error('Solo playlist sono supportate per ora: l\'URL deve contenere un parametro "list=" (es. https://www.youtube.com/playlist?list=...)');
  }
  const canonicalUrl = `https://www.youtube.com/playlist?list=${playlistId}`;

  const existing = await readCatalog();
  if (existing.sources[playlistId]) {
    return { alreadyExists: true, sourceId: playlistId, name: existing.sources[playlistId].name };
  }

  const { title, entries } = await getPlaylistEntries(canonicalUrl);
  const paths = getPaths();

  let result;
  await updateCatalog((catalog) => {
    if (catalog.sources[playlistId]) {
      result = { alreadyExists: true, sourceId: playlistId, name: catalog.sources[playlistId].name };
      return;
    }
    catalog.sources[playlistId] = {
      type: 'playlist',
      id: playlistId,
      name: title ?? `Playlist ${playlistId}`,
      url: canonicalUrl,
      lastCheckedAt: new Date().toISOString()
    };
    const ingestResult = ingestPlaylistEntries(catalog, catalog.sources[playlistId], entries, paths);
    result = {
      alreadyExists: false,
      sourceId: playlistId,
      name: catalog.sources[playlistId].name,
      newCount: ingestResult.newCount
    };
  });

  return result;
}

export async function removeSource(sourceId) {
  return updateCatalog((catalog) => {
    if (!catalog.sources[sourceId]) {
      throw new Error(`Fonte non trovata: "${sourceId}"`);
    }
    delete catalog.sources[sourceId];
  });
}
